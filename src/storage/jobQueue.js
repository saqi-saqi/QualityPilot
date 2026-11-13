/**
 * storage/jobQueue.js — SQLite-backed crash-resilient job queue.
 *
 * Replaces the in-memory queue array and runs Map. Guarantees that queued
 * and running test executions survive server restarts without requiring
 * external infrastructure (like Redis/BullMQ).
 */
import { getDatabase } from './db.js';

export class JobQueue {
  constructor({ db = getDatabase(), queueName = 'default', workerId = `worker_${process.pid}` } = {}) {
    this.db = db;
    this.queueName = queueName;
    this.workerId = workerId;
  }

  /**
   * Enqueue a test run for execution.
   */
  enqueue({ runId, payload = {}, priority = 0, maxAttempts = 1 }) {
    if (!runId) throw new Error('runId is required to enqueue a job');

    const stmt = this.db.prepare(`
      INSERT INTO job_queue (
        run_id, queue_name, status, priority, payload_json,
        attempts, max_attempts, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, 0, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(run_id) DO UPDATE SET
        status = 'pending',
        priority = excluded.priority,
        payload_json = excluded.payload_json,
        attempts = 0,
        locked_at = NULL,
        locked_by = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      runId,
      this.queueName,
      priority,
      JSON.stringify(payload),
      maxAttempts
    );

    return { runId, status: 'pending' };
  }

  /**
   * Atomically acquire the next pending job if concurrency allows.
   */
  acquireNextJob({ maxConcurrent = 2 } = {}) {
    const acquireTx = this.db.transaction(() => {
      // 1. Check current concurrency in this queue
      const activeStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM job_queue
        WHERE queue_name = ? AND status = 'running'
      `);
      const { count: activeCount } = activeStmt.get(this.queueName);

      if (activeCount >= maxConcurrent) {
        return null;
      }

      // 2. Select next job in priority order
      const selectStmt = this.db.prepare(`
        SELECT * FROM job_queue
        WHERE queue_name = ? AND status = 'pending'
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `);
      const job = selectStmt.get(this.queueName);
      if (!job) return null;

      // 3. Atomically lock the job
      const now = new Date().toISOString();
      const updateStmt = this.db.prepare(`
        UPDATE job_queue
        SET status = 'running',
            locked_at = ?,
            locked_by = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ?
      `);
      updateStmt.run(now, this.workerId, now, job.id);

      let payload = {};
      try {
        payload = JSON.parse(job.payload_json);
      } catch { /* empty */ }

      return {
        id: job.id,
        runId: job.run_id,
        queueName: job.queue_name,
        status: 'running',
        priority: job.priority,
        attempts: job.attempts + 1,
        maxAttempts: job.max_attempts,
        lockedAt: now,
        lockedBy: this.workerId,
        payload,
      };
    });

    return acquireTx();
  }

  /**
   * Mark a job completed.
   */
  completeJob(runId) {
    const stmt = this.db.prepare(`
      UPDATE job_queue
      SET status = 'completed',
          locked_at = NULL,
          locked_by = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
    `);
    const info = stmt.run(runId);
    return info.changes > 0;
  }

  /**
   * Mark a job failed, re-queuing if retries remain.
   */
  failJob(runId, error = '') {
    const job = this.getJob(runId);
    if (!job) return false;

    const shouldRetry = job.attempts < job.max_attempts;
    const nextStatus = shouldRetry ? 'pending' : 'failed';

    const stmt = this.db.prepare(`
      UPDATE job_queue
      SET status = ?,
          locked_at = NULL,
          locked_by = NULL,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
    `);
    const info = stmt.run(nextStatus, String(error || ''), runId);
    return info.changes > 0;
  }

  cancel(runId, reason = 'Cancelled by user') {
    const stmt = this.db.prepare(`
      UPDATE job_queue
      SET status = 'cancelled',
          locked_at = NULL,
          locked_by = NULL,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status IN ('pending', 'running')
    `);
    const info = stmt.run(String(reason), runId);
    return info.changes > 0;
  }

  /**
   * Recover interrupted jobs on startup.
   *
   * This is a single-process application: ANY job still marked 'running'
   * belongs to a previous process instance, so at startup we recover ALL of
   * them regardless of `locked_at` age. The `{ staleTimeoutMs }` option is
   * accepted (and ignored) for backward compatibility.
   *
   * In the same transaction, the corresponding `runs` rows are synchronized:
   * jobs with retries remaining are reset to 'pending' in job_queue and 'queued'
   * in runs table; exhausted jobs are marked 'failed' in both.
   */
  recoverStaleJobs({ staleTimeoutMs } = {}) {
    void staleTimeoutMs; // deprecated — kept for API compatibility
    const recoverTx = this.db.transaction(() => {
      // Find ALL jobs that were running when the process died.
      const runningJobs = this.db.prepare(`
        SELECT * FROM job_queue
        WHERE status = 'running'
      `).all();

      const now = new Date().toISOString();
      const interruptMessage = 'interrupted by server restart — re-run';

      let recovered = 0;
      for (const job of runningJobs) {
        const retry = job.attempts < job.max_attempts;
        if (retry) {
          this.db.prepare(`
            UPDATE job_queue
            SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(job.id);
          recovered++;
        } else {
          this.db.prepare(`
            UPDATE job_queue
            SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'Interrupted by process restart', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(job.id);
        }

        // Keep the run row in sync with job_queue in the same transaction
        const runRow = this.db.prepare('SELECT status, events_json FROM runs WHERE id = ?').get(job.run_id);
        if (runRow && (runRow.status === 'running' || runRow.status === 'queued')) {
          let events = [];
          try {
            const parsed = JSON.parse(runRow.events_json || '[]');
            if (Array.isArray(parsed)) events = parsed;
          } catch { /* keep empty */ }
          events.push({ message: interruptMessage, timestamp: now });

          if (retry) {
            this.db.prepare(`
              UPDATE runs
              SET status = 'queued',
                  events_json = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(JSON.stringify(events), job.run_id);
          } else {
            this.db.prepare(`
              UPDATE runs
              SET status = 'failed',
                  error = ?,
                  completed_at = ?,
                  events_json = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(interruptMessage, now, JSON.stringify(events), job.run_id);
          }
        }
      }
      return { totalStale: runningJobs.length, recovered };
    });

    return recoverTx();
  }

  /**
   * Fetch a job by run_id.
   */
  getJob(runId) {
    const stmt = this.db.prepare('SELECT * FROM job_queue WHERE run_id = ?');
    const job = stmt.get(runId);
    if (!job) return null;
    let payload = {};
    try {
      payload = JSON.parse(job.payload_json);
    } catch { /* empty */ }
    return {
      ...job,
      runId: job.run_id,
      payload,
    };
  }

  /**
   * Get queue statistics.
   */
  getStats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM job_queue
      WHERE queue_name = ?
      GROUP BY status
    `).all(this.queueName);

    const stats = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      if (stats[row.status] !== undefined) {
        stats[row.status] = row.count;
      }
    }
    return stats;
  }
}
