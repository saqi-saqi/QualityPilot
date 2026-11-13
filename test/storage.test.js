import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase, closeDatabase, initSchema, getSchemaVersion, MIGRATIONS } from '../src/storage/db.js';
import {
  saveRun, getRun, listRuns, deleteRun, cleanupOldRuns,
  setFindingState, getFindingStates, savePlan, getPlan, FINDING_STATES,
} from '../src/storage/runStore.js';
import { SqliteMonitorStore } from '../src/storage/monitorStore.js';
import { SqliteFlakyStore } from '../src/storage/flakyStore.js';
import {
  saveBaseline, getLatestBaseline, deleteBaselinesForMonitor,
} from '../src/storage/baselineStore.js';
import {
  saveDraft, getDraft, markApproved, listDrafts,
} from '../src/storage/planDraftStore.js';

describe('SQLite Storage Layer', () => {
  let db;

  beforeEach(() => {
    db = getDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('runStore', () => {
    const sampleRun = {
      runId: 'run_test_001',
      url: 'https://example.com/checkout',
      status: 'completed',
      mode: 'matrix',
      score: 95.5,
      startedAt: '2026-01-01T10:00:00.000Z',
      completedAt: '2026-01-01T10:02:00.000Z',
      error: null,
      options: { maxPages: 5, browsers: ['chromium', 'firefox'], concurrency: 2 },
      summary: { totalPages: 5, totalFindings: 1, bySeverity: { critical: 0, high: 1 } },
      findings: [
        {
          ruleId: 'a11y-img-alt',
          title: 'Missing image alt',
          severity: 'high',
          confidence: 'confirmed',
          pageUrl: 'https://example.com/checkout',
        },
      ],
      events: [{ message: 'Started', timestamp: '2026-01-01T10:00:00.000Z' }],
      pages: [{ url: 'https://example.com/checkout', status: 200 }],
      plan: { version: '1.0', flows: [] },
      matrixStats: { totalCells: 4, completedCells: 4 },
      workflowResults: [{ name: 'checkout-flow', passed: true }],
      trackerStats: { filed: 1, updated: 0 },
    };

    it('saves and retrieves a complete run object', () => {
      saveRun(sampleRun, db);
      const retrieved = getRun('run_test_001', db);

      assert.ok(retrieved);
      assert.equal(retrieved.runId, sampleRun.runId);
      assert.equal(retrieved.url, sampleRun.url);
      assert.equal(retrieved.status, 'completed');
      assert.equal(retrieved.score, 95.5);
      assert.deepEqual(retrieved.options, sampleRun.options);
      assert.deepEqual(retrieved.summary, sampleRun.summary);
      assert.equal(retrieved.findings.length, 1);
      assert.equal(retrieved.findings[0].ruleId, 'a11y-img-alt');
      assert.equal(retrieved.events.length, 1);
      assert.equal(retrieved.pages.length, 1);
      assert.deepEqual(retrieved.plan, sampleRun.plan);
      assert.deepEqual(retrieved.matrixStats, sampleRun.matrixStats);
      assert.deepEqual(retrieved.workflowResults, sampleRun.workflowResults);
      assert.deepEqual(retrieved.trackerStats, sampleRun.trackerStats);
    });

    it('updates existing run on conflict', () => {
      saveRun(sampleRun, db);
      const updated = {
        ...sampleRun,
        status: 'failed',
        error: 'Network timeout',
        score: 0,
      };
      saveRun(updated, db);

      const retrieved = getRun('run_test_001', db);
      assert.equal(retrieved.status, 'failed');
      assert.equal(retrieved.error, 'Network timeout');
      assert.equal(retrieved.score, 0);
    });

    it('lists runs with pagination and filtering', () => {
      saveRun({ ...sampleRun, runId: 'r1', startedAt: '2026-01-01T10:00:00.000Z', status: 'completed' }, db);
      saveRun({ ...sampleRun, runId: 'r2', startedAt: '2026-01-01T11:00:00.000Z', status: 'failed', url: 'https://other.com' }, db);
      saveRun({ ...sampleRun, runId: 'r3', startedAt: '2026-01-01T12:00:00.000Z', status: 'completed' }, db);

      const all = listRuns({ db });
      assert.equal(all.length, 3);
      assert.equal(all[0].runId, 'r3'); // Sorted DESC

      const filteredStatus = listRuns({ db, status: 'failed' });
      assert.equal(filteredStatus.length, 1);
      assert.equal(filteredStatus[0].runId, 'r2');

      const filteredUrl = listRuns({ db, url: 'https://other.com' });
      assert.equal(filteredUrl.length, 1);
      assert.equal(filteredUrl[0].runId, 'r2');

      const paginated = listRuns({ db, limit: 2, offset: 1 });
      assert.equal(paginated.length, 2);
      assert.equal(paginated[0].runId, 'r2');
      assert.equal(paginated[1].runId, 'r1');
    });

    it('deletes a run', () => {
      saveRun(sampleRun, db);
      assert.ok(getRun('run_test_001', db));
      const deleted = deleteRun('run_test_001', db);
      assert.equal(deleted, true);
      assert.equal(getRun('run_test_001', db), null);
    });

    it('cleans up old runs past maxAgeMs', () => {
      const oldTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const newTime = new Date().toISOString();

      saveRun({ ...sampleRun, runId: 'old_run', startedAt: oldTime }, db);
      saveRun({ ...sampleRun, runId: 'new_run', startedAt: newTime }, db);

      const cleaned = cleanupOldRuns(24 * 3600 * 1000, db);
      assert.equal(cleaned, 1);
      assert.equal(getRun('old_run', db), null);
      assert.ok(getRun('new_run', db));
    });

    it('clamps listRuns limit into [1, 200]', () => {
      for (let i = 0; i < 5; i++) {
        saveRun({ ...sampleRun, runId: `clamp_${i}`, startedAt: `2026-02-0${i + 1}T10:00:00.000Z` }, db);
      }
      // Absurdly large limit → capped at 200 (and can't dump unbounded rows)
      assert.equal(listRuns({ db, limit: 100000 }).length, 5);
      // Zero/negative/NaN limit → at least 1
      assert.equal(listRuns({ db, limit: 0 }).length, 1);
      assert.equal(listRuns({ db, limit: -5 }).length, 1);
      assert.equal(listRuns({ db, limit: 'bogus' }).length, 5);
      // Normal clamping honors valid values
      assert.equal(listRuns({ db, limit: 2 }).length, 2);
    });

    it('persists + loads finding triage states keyed ruleId|pageUrl', () => {
      saveRun(sampleRun, db);
      setFindingState('run_test_001', 'a11y-img-alt', 'https://example.com/checkout', 'acknowledged', db);
      setFindingState('run_test_001', 'seo-meta', 'https://example.com/checkout', 'false_positive', db);

      const states = getFindingStates('run_test_001', db);
      assert.ok(states instanceof Map);
      assert.equal(states.get('a11y-img-alt|https://example.com/checkout'), 'acknowledged');
      assert.equal(states.get('seo-meta|https://example.com/checkout'), 'false_positive');

      // Upsert — same key overwrites
      setFindingState('run_test_001', 'a11y-img-alt', 'https://example.com/checkout', 'fixed', db);
      const updated = getFindingStates('run_test_001', db);
      assert.equal(updated.get('a11y-img-alt|https://example.com/checkout'), 'fixed');

      // Unknown run → empty Map
      assert.equal(getFindingStates('nope', db).size, 0);
    });

    it('rejects invalid finding triage states', () => {
      saveRun(sampleRun, db);
      assert.throws(() => setFindingState('run_test_001', 'r', 'u', 'bogus', db), /Invalid state/);
      assert.throws(() => setFindingState('', 'r', 'u', 'open', db), /runId/);
      assert.deepEqual(FINDING_STATES, ['open', 'acknowledged', 'false_positive', 'fixed']);
    });

    it('savePlan + getPlan round-trip the approved plan JSON', () => {
      saveRun(sampleRun, db);
      const plan = { schemaVersion: 1, id: 'plan_x', targetUrl: 'https://example.com', flows: [{ name: 'Login' }] };
      assert.equal(savePlan('run_test_001', plan, db), true);

      const loaded = getPlan('run_test_001', db);
      assert.deepEqual(loaded, plan);

      // Missing run → false / null
      assert.equal(savePlan('ghost-run', plan, db), false);
      assert.equal(getPlan('ghost-run', db), null);
      // Run without a plan → null
      assert.equal(getPlan('clamp_0', db), null);
    });
  });

  describe('SqliteMonitorStore', () => {
    it('adds, gets, updates, and removes monitors', async () => {
      const store = new SqliteMonitorStore({ db });

      const res = await store.add({
        id: 'monitor-alpha',
        label: 'Alpha Site',
        url: 'https://alpha.example.com',
        intervalHours: 12,
        options: { maxPages: 3 },
      });

      assert.equal(res.ok, true);
      assert.equal(res.monitor.id, 'monitor-alpha');

      // Duplicate rejection
      const dup = await store.add({
        id: 'monitor-alpha',
        label: 'Alpha 2',
        url: 'https://alpha2.example.com',
      });
      assert.equal(dup.ok, false);

      // List & Get
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'monitor-alpha');

      const fetched = await store.get('monitor-alpha');
      assert.equal(fetched.label, 'Alpha Site');

      // Update
      const updated = await store.update('monitor-alpha', {
        lastScore: 88,
        lastStatus: 'completed',
        lastRunAt: new Date().toISOString(),
      });
      assert.equal(updated.lastScore, 88);
      assert.equal(updated.lastStatus, 'completed');

      // Due check
      const due = await store.dueMonitors(Date.now() + 24 * 3600 * 1000);
      assert.equal(due.length, 1);

      // Remove
      const removed = await store.remove('monitor-alpha');
      assert.equal(removed, true);
      assert.equal((await store.list()).length, 0);
    });

    it('accepts + persists roles (JSON array, default []) on create and update', async () => {
      const store = new SqliteMonitorStore({ db });

      const res = await store.add({
        id: 'monitor-roles',
        label: 'Roles Site',
        url: 'https://roles.example.com',
        roles: ['admin', 'editor'],
      });
      assert.equal(res.ok, true, res.error);
      assert.deepEqual(res.monitor.roles, ['admin', 'editor']);

      const fetched = await store.get('monitor-roles');
      assert.deepEqual(fetched.roles, ['admin', 'editor']);

      // Default when absent
      const bare = await store.add({ id: 'monitor-bare', label: 'Bare', url: 'https://bare.example.com' });
      assert.equal(bare.ok, true);
      assert.deepEqual((await store.get('monitor-bare')).roles, []);

      // Update replaces roles
      const updated = await store.update('monitor-roles', { roles: ['viewer'] });
      assert.deepEqual(updated.roles, ['viewer']);
    });

    it('rejects malformed roles', async () => {
      const store = new SqliteMonitorStore({ db });
      const bad = await store.add({
        id: 'monitor-bad-roles',
        label: 'Bad Roles',
        url: 'https://bad.example.com',
        roles: ['!!invalid!!'],
      });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /Invalid role/);

      await store.add({ id: 'monitor-bad-2', label: 'B2', url: 'https://b2.example.com' });
      await assert.rejects(
        () => store.update('monitor-bad-2', { roles: ['way-too-long-role-name-overflow-xxxx'] }),
        /Invalid role/
      );
    });

    it('update() whitelists known fields — unknown patch keys are dropped', async () => {
      const store = new SqliteMonitorStore({ db });
      await store.add({ id: 'monitor-wl', label: 'WL', url: 'https://wl.example.com' });

      const updated = await store.update('monitor-wl', {
        label: 'WL2',
        lastStatus: 'queued',
        // Unknown / untrusted fields must not land in the monitor record
        apiKey: 'should-not-persist',
        webhook_secret: 'nope',
        dropTable: true,
      });

      assert.equal(updated.label, 'WL2');
      assert.equal(updated.lastStatus, 'queued');
      assert.equal(updated.apiKey, undefined);
      assert.equal(updated.webhook_secret, undefined);
      assert.equal(updated.dropTable, undefined);
    });
  });

  describe('SqliteFlakyStore', () => {
    it('records runs and detects flaky tests across history (single shared algorithm, ≥3 alternations)', async () => {
      const store = new SqliteFlakyStore({ db });

      const makeRun = (runId, startedAt, failed) => ({
        runId,
        url: 'https://example.com',
        startedAt,
        status: 'completed',
        options: { maxPages: 5, maxDepth: 2 },
        findings: failed
          ? [{ ruleId: 'flaky-link', severity: 'high', confidence: 'confirmed' }]
          : [], // passed!
      });

      // fail → pass → fail → pass = 3 alternations → flaky
      await store.recordRun(makeRun('r1', '2026-01-01T00:00:00Z', true));
      await store.recordRun(makeRun('r2', '2026-01-02T00:00:00Z', false));
      await store.recordRun(makeRun('r3', '2026-01-03T00:00:00Z', true));
      await store.recordRun(makeRun('r4', '2026-01-04T00:00:00Z', false));

      const flaky = await store.detectFlakyTests();
      assert.equal(flaky.length, 1);
      assert.equal(flaky[0].ruleId, 'flaky-link');
      assert.equal(flaky[0].url, 'https://example.com');
      assert.equal(flaky[0].passCount, 2);
      assert.equal(flaky[0].failCount, 2);
      assert.equal(flaky[0].alternations, 3);
      assert.equal(flaky[0].flakinessRatio, 0.5);
      // Runs recorded with options → grouped under a normalized options key
      assert.match(flaky[0].optionsKey, /maxPages=5/);
    });

    it('does not flag a single pass/fail pair (needs ≥3 alternations)', async () => {
      const store = new SqliteFlakyStore({ db });
      await store.recordRun({
        runId: 'r1', url: 'https://example.com', startedAt: '2026-01-01T00:00:00Z', status: 'completed',
        findings: [{ ruleId: 'flaky-link' }],
      });
      await store.recordRun({
        runId: 'r2', url: 'https://example.com', startedAt: '2026-01-02T00:00:00Z', status: 'completed',
        findings: [],
      });
      assert.equal((await store.detectFlakyTests()).length, 0);
    });
  });

  describe('baselineStore', () => {
    it('saves, fetches, and deletes baselines keyed (monitor, page, viewport, label)', () => {
      const saved = saveBaseline({
        monitorId: 'mon-1',
        pageUrl: 'https://example.com/home',
        viewport: { width: 1280, height: 720, name: 'desktop' },
        label: 'hero',
        path: 'data/baselines/mon-1-hero.png',
        hash: 'deadbeef',
      }, db);

      assert.ok(saved.id);
      assert.equal(saved.viewport, '1280x720'); // normalized object → string key
      assert.equal(saved.hash, 'deadbeef');

      const fetched = getLatestBaseline('mon-1', 'https://example.com/home', '1280x720', 'hero', db);
      assert.ok(fetched);
      assert.equal(fetched.path, 'data/baselines/mon-1-hero.png');

      // Re-saving the same key upserts (newest capture wins)
      saveBaseline({
        monitorId: 'mon-1',
        pageUrl: 'https://example.com/home',
        viewport: '1280x720',
        label: 'hero',
        path: 'data/baselines/mon-1-hero-v2.png',
        hash: 'feedface',
      }, db);
      const updated = getLatestBaseline('mon-1', 'https://example.com/home', '1280x720', 'hero', db);
      assert.equal(updated.hash, 'feedface');
      assert.equal(updated.path, 'data/baselines/mon-1-hero-v2.png');

      // Unknown key → null
      assert.equal(getLatestBaseline('mon-1', 'https://example.com/other', '1280x720', 'hero', db), null);
      // Default label
      saveBaseline({ monitorId: 'mon-2', pageUrl: 'https://example.com/x', viewport: '800x600' }, db);
      assert.ok(getLatestBaseline('mon-2', 'https://example.com/x', '800x600', 'default', db));

      assert.equal(deleteBaselinesForMonitor('mon-1', db), 1);
      assert.equal(getLatestBaseline('mon-1', 'https://example.com/home', '1280x720', 'hero', db), null);
      assert.ok(getLatestBaseline('mon-2', 'https://example.com/x', '800x600', 'default', db));
    });

    it('requires monitorId + pageUrl', () => {
      assert.throws(() => saveBaseline({ pageUrl: 'https://x.com' }, db), /monitorId/);
      assert.throws(() => saveBaseline({ monitorId: 'm' }, db), /pageUrl/);
    });
  });

  describe('planDraftStore', () => {
    it('saves drafts with a generated id and loads them', () => {
      const plan = { schemaVersion: 1, id: 'plan_d1', targetUrl: 'https://example.com' };
      const id = saveDraft('https://example.com', plan, db);
      assert.ok(id);

      const draft = getDraft(id, db);
      assert.ok(draft);
      assert.equal(draft.status, 'draft');
      assert.equal(draft.url, 'https://example.com');
      assert.deepEqual(draft.plan, plan);

      assert.equal(getDraft('does-not-exist', db), null);
    });

    it('markApproved transitions a draft + is idempotent', () => {
      const id = saveDraft('https://example.com', { schemaVersion: 1, id: 'p' }, db);
      assert.equal(markApproved(id, db), true);
      assert.equal(getDraft(id, db).status, 'approved');
      // Approving again → still true (idempotent), status stays approved
      assert.equal(markApproved(id, db), true);
      assert.equal(getDraft(id, db).status, 'approved');
      // Unknown id → false
      assert.equal(markApproved('ghost', db), false);
    });

    it('lists drafts newest-first with a limit', () => {
      for (let i = 0; i < 3; i++) {
        saveDraft(`https://example.com/${i}`, { n: i }, db);
      }
      const drafts = listDrafts(10, db);
      assert.ok(drafts.length >= 3);
      assert.ok(drafts[0].createdAt >= drafts[drafts.length - 1].createdAt);
      assert.equal(listDrafts(2, db).length, 2);
    });

    it('purges drafts older than 24h lazily on read', () => {
      const id = saveDraft('https://example.com/old', { stale: true }, db);
      // Backdate the draft past the TTL
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE plan_drafts SET created_at = ? WHERE id = ?').run(stale, id);

      assert.equal(getDraft(id, db), null); // purged on read
    });
  });

  describe('migrations', () => {
    it('brings a fresh database to the latest schema version', () => {
      const version = getSchemaVersion(db);
      const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
      assert.equal(version, latest);
    });

    it('creates the finding_states, baselines, and plan_drafts tables with exact contracts', () => {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
      );
      for (const table of ['finding_states', 'baselines', 'plan_drafts']) {
        assert.ok(tables.has(table), `missing table: ${table}`);
      }
      const findingStateCols = db.prepare('PRAGMA table_info(finding_states)').all().map(c => c.name);
      assert.deepEqual(findingStateCols.sort(), ['page_url', 'rule_id', 'run_id', 'state', 'updated_at'].sort());

      const baselineCols = new Set(db.prepare('PRAGMA table_info(baselines)').all().map(c => c.name));
      for (const col of ['id', 'monitor_id', 'page_url', 'viewport', 'label', 'path', 'hash', 'created_at']) {
        assert.ok(baselineCols.has(col), `baselines missing column ${col}`);
      }

      const draftCols = new Set(db.prepare('PRAGMA table_info(plan_drafts)').all().map(c => c.name));
      for (const col of ['id', 'url', 'plan_json', 'status', 'created_at']) {
        assert.ok(draftCols.has(col), `plan_drafts missing column ${col}`);
      }
    });

    it('runs.plan_json and monitors.roles exist for new and migrated databases', () => {
      const runCols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
      assert.ok(runCols.has('plan_json'));
      const monitorCols = new Set(db.prepare('PRAGMA table_info(monitors)').all().map(c => c.name));
      assert.ok(monitorCols.has('roles'));
      // default '[]'
      const defaults = db.prepare('PRAGMA table_info(monitors)').all();
      const rolesCol = defaults.find(c => c.name === 'roles');
      assert.equal(rolesCol.dflt_value, "'[]'");
    });
  });
});
