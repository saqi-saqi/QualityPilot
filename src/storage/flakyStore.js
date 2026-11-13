/**
 * storage/flakyStore.js — SQLite persistence for flaky test tracking.
 *
 * Detection itself lives in ONE place: matrix/flakyTracker.js
 * `detectFlakyFromRuns()`. This store only persists run summaries and
 * delegates analysis to that shared algorithm.
 */
import { getDatabase } from './db.js';
import { buildRunSummary, detectFlakyFromRuns } from '../matrix/flakyTracker.js';

export class SqliteFlakyStore {
  constructor({ db = getDatabase() } = {}) {
    this.db = db;
  }

  /**
   * Record a run's ruleIds into flaky history.
   */
  async recordRun(run) {
    const summary = buildRunSummary(run);
    const ruleIds = Array.from(summary.ruleIds || []);

    const stmt = this.db.prepare(`
      INSERT INTO flaky_history (run_id, url, started_at, status, rule_ids_json, options_key)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        url = excluded.url,
        started_at = excluded.started_at,
        status = excluded.status,
        rule_ids_json = excluded.rule_ids_json,
        options_key = excluded.options_key
    `);

    stmt.run(
      summary.runId,
      summary.url,
      summary.startedAt || new Date().toISOString(),
      summary.status || 'completed',
      JSON.stringify(ruleIds),
      summary.optionsKey || ''
    );
  }

  /**
   * Detect flaky tests across all stored runs in SQLite.
   * Delegates to the shared detectFlakyFromRuns algorithm.
   */
  async detectFlakyTests() {
    const rows = this.db.prepare(`
      SELECT run_id, url, started_at, status, rule_ids_json, options_key
      FROM flaky_history
      ORDER BY started_at ASC
    `).all();

    const runs = rows.map(r => {
      let ruleIds = [];
      try {
        ruleIds = JSON.parse(r.rule_ids_json);
      } catch { /* empty */ }
      return {
        runId: r.run_id,
        url: r.url,
        startedAt: r.started_at,
        status: r.status,
        ruleIds: Array.isArray(ruleIds) ? ruleIds : [],
        optionsKey: r.options_key || '',
      };
    });

    return detectFlakyFromRuns(runs);
  }
}
