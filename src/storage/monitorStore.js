/**
 * storage/monitorStore.js — SQLite persistence for scheduled site monitors.
 *
 * Implements the MonitorStore interface with relational SQLite storage.
 * `roles` (JSON array of role-name strings) records which auth roles a
 * monitor's recorded login sessions cover; updates are whitelisted to known
 * fields so an untrusted PATCH body can't inject arbitrary columns.
 */
import { getDatabase } from './db.js';
import { MonitorSchema, isDue } from '../services/monitors.js';

function safeParse(jsonStr, fallback = {}) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

/** Role names are short slugs — the same pattern the dashboard enforces. */
const ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Normalize + validate a roles list. Returns { ok, roles } | { ok: false, error }. */
function validateRoles(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const roles = [...new Set(list.map(r => String(r).trim()).filter(Boolean))];
  for (const role of roles) {
    if (!ROLE_PATTERN.test(role)) {
      return { ok: false, error: `Invalid role: "${role}" — roles must match ^[a-zA-Z0-9_-]{1,32}$` };
    }
  }
  return { ok: true, roles };
}

/** Fields update() is allowed to write — everything else in a patch is dropped. */
const UPDATABLE_FIELDS = new Set([
  // editable config
  'label', 'url', 'intervalHours', 'enabled', 'onlyNewFindings', 'options', 'webhookUrl', 'roles',
  // run/state bookkeeping (managed by the scheduler + record-login flow)
  'lastRunAt', 'lastRunId', 'lastScore', 'lastStatus', 'sessionRecordedAt', 'sessionExpired',
]);

export class SqliteMonitorStore {
  constructor({ db = getDatabase() } = {}) {
    this.db = db;
  }

  _rowToMonitor(row) {
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      intervalHours: row.interval_hours,
      enabled: Boolean(row.enabled),
      onlyNewFindings: Boolean(row.only_new_findings),
      webhookUrl: row.webhook_url || '',
      roles: safeParse(row.roles, []),
      options: safeParse(row.options_json, {}),
      lastRunAt: row.last_run_at || null,
      lastRunId: row.last_run_id || null,
      lastScore: row.last_score !== null ? row.last_score : null,
      lastStatus: row.last_status || null,
      sessionRecordedAt: row.session_recorded_at || null,
      sessionExpired: Boolean(row.session_expired),
    };
  }

  async list() {
    const rows = this.db.prepare('SELECT * FROM monitors ORDER BY created_at ASC').all();
    return rows.map(r => this._rowToMonitor(r));
  }

  async get(id) {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
    return this._rowToMonitor(row);
  }

  async add(input) {
    // roles live outside MonitorSchema (services/monitors.js is strict about
    // run options) — validate them here so both paths persist them.
    let roles = [];
    if (input.roles !== undefined) {
      const verdict = validateRoles(input.roles);
      if (!verdict.ok) return { ok: false, error: verdict.error };
      roles = verdict.roles;
    }

    const parsed = MonitorSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }

    const m = parsed.data;
    const existing = this.db.prepare('SELECT id FROM monitors WHERE id = ?').get(m.id);
    if (existing) {
      return { ok: false, error: `Monitor id already exists: ${m.id}` };
    }

    const stmt = this.db.prepare(`
      INSERT INTO monitors (
        id, label, url, interval_hours, enabled, only_new_findings,
        webhook_url, roles, options_json, last_run_at, last_run_id, last_score,
        last_status, session_recorded_at, session_expired, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      m.id,
      m.label,
      m.url,
      m.intervalHours,
      m.enabled ? 1 : 0,
      m.onlyNewFindings ? 1 : 0,
      m.webhookUrl || '',
      JSON.stringify(roles),
      JSON.stringify(m.options || {}),
      m.lastRunAt || null,
      m.lastRunId || null,
      m.lastScore !== undefined ? m.lastScore : null,
      m.lastStatus || null,
      input.sessionRecordedAt || null,
      input.sessionExpired ? 1 : 0
    );

    return { ok: true, monitor: { ...m, roles } };
  }

  async remove(id) {
    const stmt = this.db.prepare('DELETE FROM monitors WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  async update(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;

    // Whitelist known fields — never spread an untrusted patch blindly.
    const merged = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!UPDATABLE_FIELDS.has(key)) continue;
      merged[key] = value;
    }

    if (patch.roles !== undefined) {
      const verdict = validateRoles(patch.roles);
      if (!verdict.ok) {
        const err = new Error(verdict.error);
        err.statusCode = 400;
        throw err;
      }
      merged.roles = verdict.roles;
    } else if (!Array.isArray(merged.roles)) {
      merged.roles = [];
    }

    const stmt = this.db.prepare(`
      UPDATE monitors SET
        label = ?,
        url = ?,
        interval_hours = ?,
        enabled = ?,
        only_new_findings = ?,
        webhook_url = ?,
        roles = ?,
        options_json = ?,
        last_run_at = ?,
        last_run_id = ?,
        last_score = ?,
        last_status = ?,
        session_recorded_at = ?,
        session_expired = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      merged.label,
      merged.url,
      merged.intervalHours,
      merged.enabled ? 1 : 0,
      merged.onlyNewFindings ? 1 : 0,
      merged.webhookUrl || '',
      JSON.stringify(merged.roles || []),
      JSON.stringify(merged.options || {}),
      merged.lastRunAt || null,
      merged.lastRunId || null,
      merged.lastScore !== undefined ? merged.lastScore : null,
      merged.lastStatus || null,
      merged.sessionRecordedAt || null,
      merged.sessionExpired ? 1 : 0,
      id
    );

    return merged;
  }

  async dueMonitors(now = Date.now()) {
    const all = await this.list();
    return all.filter(m => isDue(m, now));
  }
}
