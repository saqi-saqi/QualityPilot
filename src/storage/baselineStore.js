/**
 * storage/baselineStore.js — SQLite persistence for visual-regression baselines.
 *
 * A baseline is a reference screenshot + content hash keyed by
 * (monitorId, pageUrl, viewport, label). The visual executor keys baselines on
 * `ctx.options.monitorId || ctx.monitorId || ctx.runId` (monitorId preferred).
 * Re-saving the same key upserts — the newest capture wins.
 */
import { getDatabase } from './db.js';

/**
 * Normalize a viewport spec into a stable string key.
 * Accepts { width, height, name? } objects, "1280x720" strings, or null.
 */
export function normalizeViewport(viewport) {
  if (viewport == null) return 'default';
  if (typeof viewport === 'string') return viewport.trim() || 'default';
  if (typeof viewport === 'object') {
    const { width, height } = viewport;
    if (width != null && height != null) return `${width}x${height}`;
    if (viewport.name) return String(viewport.name);
  }
  return String(viewport);
}

function rowToBaseline(row) {
  if (!row) return null;
  return {
    id: row.id,
    monitorId: row.monitor_id,
    pageUrl: row.page_url,
    viewport: row.viewport,
    label: row.label,
    path: row.path,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

/**
 * Save (upsert) a baseline for (monitorId, pageUrl, viewport, label).
 * @param {object} input { monitorId, pageUrl, viewport, label, path, hash }
 * @param {object} [db]
 * @returns {object} the persisted baseline row (domain shape)
 */
export function saveBaseline(input, db = getDatabase()) {
  if (!input || !input.monitorId) throw new Error('saveBaseline requires monitorId');
  if (!input.pageUrl) throw new Error('saveBaseline requires pageUrl');

  const viewport = normalizeViewport(input.viewport);
  const label = input.label || 'default';
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO baselines (monitor_id, page_url, viewport, label, path, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id, page_url, viewport, label) DO UPDATE SET
      path = excluded.path,
      hash = excluded.hash,
      created_at = excluded.created_at
  `);

  stmt.run(
    input.monitorId,
    input.pageUrl,
    viewport,
    label,
    input.path || null,
    input.hash || null,
    now
  );

  const row = db.prepare(`
    SELECT * FROM baselines WHERE monitor_id = ? AND page_url = ? AND viewport = ? AND label = ?
  `).get(input.monitorId, input.pageUrl, viewport, label);

  return rowToBaseline(row);
}

/**
 * Get the newest baseline for a (monitorId, pageUrl, viewport, label) key.
 * @returns {object|null}
 */
export function getLatestBaseline(monitorId, pageUrl, viewport, label, db = getDatabase()) {
  const row = db.prepare(`
    SELECT * FROM baselines
    WHERE monitor_id = ? AND page_url = ? AND viewport = ? AND label = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(monitorId, pageUrl, normalizeViewport(viewport), label || 'default');
  return rowToBaseline(row);
}

/**
 * Delete every baseline recorded for a monitor (called when the monitor is removed).
 * @returns {number} rows deleted
 */
export function deleteBaselinesForMonitor(monitorId, db = getDatabase()) {
  const info = db.prepare('DELETE FROM baselines WHERE monitor_id = ?').run(monitorId);
  return info.changes;
}
