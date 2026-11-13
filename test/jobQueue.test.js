import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase, closeDatabase } from '../src/storage/db.js';
import { JobQueue } from '../src/storage/jobQueue.js';
import { saveRun, getRun } from '../src/storage/runStore.js';

describe('JobQueue (SQLite-backed)', () => {
  let db;
  let queue;

  beforeEach(() => {
    db = getDatabase(':memory:');
    queue = new JobQueue({ db, workerId: 'test-worker-1' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('enqueues jobs and acquires them in priority order', () => {
    queue.enqueue({ runId: 'run-low', priority: 1, payload: { url: 'https://low.com' } });
    queue.enqueue({ runId: 'run-high', priority: 10, payload: { url: 'https://high.com' } });
    queue.enqueue({ runId: 'run-mid', priority: 5, payload: { url: 'https://mid.com' } });

    const first = queue.acquireNextJob({ maxConcurrent: 10 });
    assert.ok(first);
    assert.equal(first.runId, 'run-high');
    assert.equal(first.status, 'running');
    assert.equal(first.attempts, 1);
    assert.equal(first.payload.url, 'https://high.com');

    const second = queue.acquireNextJob({ maxConcurrent: 10 });
    assert.ok(second);
    assert.equal(second.runId, 'run-mid');

    const third = queue.acquireNextJob({ maxConcurrent: 10 });
    assert.ok(third);
    assert.equal(third.runId, 'run-low');

    const fourth = queue.acquireNextJob({ maxConcurrent: 10 });
    assert.equal(fourth, null);
  });

  it('respects concurrency limits', () => {
    queue.enqueue({ runId: 'job-1' });
    queue.enqueue({ runId: 'job-2' });
    queue.enqueue({ runId: 'job-3' });

    const job1 = queue.acquireNextJob({ maxConcurrent: 2 });
    assert.ok(job1);
    const job2 = queue.acquireNextJob({ maxConcurrent: 2 });
    assert.ok(job2);

    // Concurrency limit of 2 reached
    const job3 = queue.acquireNextJob({ maxConcurrent: 2 });
    assert.equal(job3, null);

    // Complete job 1
    queue.completeJob(job1.runId);

    // Now job 3 can be acquired
    const job3Acquired = queue.acquireNextJob({ maxConcurrent: 2 });
    assert.ok(job3Acquired);
    assert.equal(job3Acquired.runId, 'job-3');
  });

  it('retries a failed job when attempts < maxAttempts', () => {
    queue.enqueue({ runId: 'retry-job', maxAttempts: 2 });

    const job = queue.acquireNextJob();
    assert.equal(job.attempts, 1);

    // Mark failed
    const failed = queue.failJob('retry-job', 'Transient error');
    assert.equal(failed, true);

    const recheck = queue.getJob('retry-job');
    assert.equal(recheck.status, 'pending');

    // Should be re-acquirable
    const retriedJob = queue.acquireNextJob();
    assert.ok(retriedJob);
    assert.equal(retriedJob.runId, 'retry-job');
    assert.equal(retriedJob.attempts, 2);

    // Fail again — maxAttempts (2) reached
    queue.failJob('retry-job', 'Permanent failure');
    const finalJob = queue.getJob('retry-job');
    assert.equal(finalJob.status, 'failed');
    assert.equal(finalJob.last_error, 'Permanent failure');
  });

  it('recovers stale or interrupted jobs on process restart', () => {
    queue.enqueue({ runId: 'in-flight-1', maxAttempts: 2 });
    queue.enqueue({ runId: 'in-flight-exhausted', maxAttempts: 1 });

    const job1 = queue.acquireNextJob();
    const job2 = queue.acquireNextJob();

    // Simulate process crash: jobs were locked with an older timestamp
    const oldTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare('UPDATE job_queue SET locked_at = ?').run(oldTime);

    // Worker restarts and calls recoverStaleJobs
    const recovery = queue.recoverStaleJobs({ staleTimeoutMs: 15 * 60 * 1000 });
    assert.equal(recovery.totalStale, 2);
    assert.equal(recovery.recovered, 1); // Only in-flight-1 has retries remaining

    // in-flight-1 is reset to pending
    const state1 = queue.getJob('in-flight-1');
    assert.equal(state1.status, 'pending');

    // in-flight-exhausted is marked failed
    const state2 = queue.getJob('in-flight-exhausted');
    assert.equal(state2.status, 'failed');
  });

  it('recovers ALL running jobs regardless of locked_at age (single-process app)', () => {
    queue.enqueue({ runId: 'fresh-crash', maxAttempts: 1 });
    queue.acquireNextJob();
    // locked_at is a SECOND old — a 15-minute stale filter would skip it,
    // but a restart means the owning process is gone: recover it anyway.
    const recovery = queue.recoverStaleJobs();
    assert.equal(recovery.totalStale, 1);
    assert.equal(recovery.recovered, 0); // maxAttempts=1 → marked failed
    assert.equal(queue.getJob('fresh-crash').status, 'failed');
  });

  it('marks the corresponding runs rows failed with an interruption event in the same transaction', () => {
    // Seed a run row that was executing when the process died
    saveRun({
      runId: 'run_interrupted',
      url: 'https://example.com',
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [{ message: 'Starting', timestamp: new Date().toISOString() }],
    }, db);

    queue.enqueue({ runId: 'run_interrupted', maxAttempts: 1 });
    queue.acquireNextJob();
    const recovery = queue.recoverStaleJobs();
    assert.equal(recovery.totalStale, 1);

    const run = getRun('run_interrupted', db);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /interrupted by server restart/);
    const lastEvent = run.events[run.events.length - 1];
    assert.match(lastEvent.message, /interrupted by server restart/);
  });

  it('resets job to pending and run to queued when attempts remain on recovery', () => {
    saveRun({
      runId: 'run_retryable',
      url: 'https://example.com',
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [{ message: 'Starting', timestamp: new Date().toISOString() }],
    }, db);

    queue.enqueue({ runId: 'run_retryable', maxAttempts: 2 });
    queue.acquireNextJob();
    const recovery = queue.recoverStaleJobs();
    assert.equal(recovery.totalStale, 1);
    assert.equal(recovery.recovered, 1);

    const job = queue.getJob('run_retryable');
    assert.equal(job.status, 'pending');

    const run = getRun('run_retryable', db);
    assert.equal(run.status, 'queued');
  });

  it('returns queue stats', () => {
    queue.enqueue({ runId: 'j1' });
    queue.enqueue({ runId: 'j2' });
    const j1 = queue.acquireNextJob();

    queue.enqueue({ runId: 'j3' });
    const j2 = queue.acquireNextJob();
    queue.completeJob(j2.runId);

    const stats = queue.getStats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.running, 1);
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 0);
  });

  it('cancels pending and running jobs without re-queuing them', () => {
    queue.enqueue({ runId: 'pending-job' });
    assert.equal(queue.cancel('pending-job'), true);
    assert.equal(queue.getJob('pending-job').status, 'cancelled');
    assert.equal(queue.acquireNextJob(), null);

    queue.enqueue({ runId: 'running-job' });
    queue.acquireNextJob();
    assert.equal(queue.cancel('running-job'), true);
    assert.equal(queue.getJob('running-job').status, 'cancelled');
  });
});
