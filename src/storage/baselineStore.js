/**
 * storage/baselineStore.js — SQLite persistence for visual-regression baselines
 * and baseline review decisions (masks, approvals, waivers).
 *
 * A baseline is a reference screenshot + content hash + optional CSS mask
 * selectors + review decision keyed by (monitorId, pageUrl, viewport, label).
 */
import { getDatabase } from './db.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

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

/** Normalize mask selector inputs (comma/newline string or array) into clean array. */
export function normalizeMaskSelectors(masks) {
  if (masks == null) return [];
  const rawList = (Array.isArray(masks) ? masks : [masks])
    .flatMap((entry) => String(entry || '').split(/[\n,]+/));
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    const s = String(item || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
    maskSelectors: parseJsonSafe(row.mask_selectors_json, []),
    status: row.review_status || 'active',
    waiverReason: row.waiver_reason || null,
    waiverExpiresAt: row.waiver_expires_at || null,
    decidedAt: row.decided_at || null,
    decidedBy: row.decided_by || null,
    createdAt: row.created_at,
  };
}

function rowToDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    baselineId: row.baseline_id,
    monitorId: row.monitor_id,
    runId: row.run_id || null,
    pageUrl: row.page_url,
    viewport: row.viewport,
    label: row.label,
    action: row.action,
    maskSelectors: parseJsonSafe(row.mask_selectors_json, []),
    waiverReason: row.waiver_reason || null,
    waiverExpiresAt: row.waiver_expires_at || null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at,
  };
}

function isDateExpired(expiresAt) {
  if (!expiresAt) return false;
  const s = String(expiresAt).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const endMs = Date.parse(`${s}T23:59:59.999Z`);
  return Number.isFinite(endMs) && Date.now() > endMs;
}

/**
 * Save (upsert) a baseline for (monitorId, pageUrl, viewport, label).
 * Preserves existing maskSelectors/review decision unless explicitly provided.
 */
export function saveBaseline(input, db = getDatabase()) {
  if (!input || !input.monitorId) throw new Error('saveBaseline requires monitorId');
  if (!input.pageUrl) throw new Error('saveBaseline requires pageUrl');

  const viewport = normalizeViewport(input.viewport);
  const label = input.label || 'default';
  const now = new Date().toISOString();
  const hasMasks = Array.isArray(input.maskSelectors);
  const masksJson = hasMasks ? JSON.stringify(normalizeMaskSelectors(input.maskSelectors)) : null;

  const stmt = db.prepare(`
    INSERT INTO baselines (
      monitor_id, page_url, viewport, label, path, hash,
      mask_selectors_json, review_status, waiver_reason, waiver_expires_at,
      decided_at, decided_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id, page_url, viewport, label) DO UPDATE SET
      path = COALESCE(excluded.path, baselines.path),
      hash = COALESCE(excluded.hash, baselines.hash),
      mask_selectors_json = COALESCE(excluded.mask_selectors_json, baselines.mask_selectors_json),
      review_status = COALESCE(excluded.review_status, baselines.review_status),
      waiver_reason = COALESCE(excluded.waiver_reason, baselines.waiver_reason),
      waiver_expires_at = COALESCE(excluded.waiver_expires_at, baselines.waiver_expires_at),
      decided_at = COALESCE(excluded.decided_at, baselines.decided_at),
      decided_by = COALESCE(excluded.decided_by, baselines.decided_by),
      created_at = excluded.created_at
  `);

  stmt.run(
    input.monitorId,
    input.pageUrl,
    viewport,
    label,
    input.path || null,
    input.hash || null,
    masksJson,
    input.status || null,
    input.waiverReason ?? null,
    input.waiverExpiresAt ?? null,
    input.decidedAt ?? null,
    input.decidedBy ?? null,
    now
  );

  const row = db.prepare(`
    SELECT * FROM baselines WHERE monitor_id = ? AND page_url = ? AND viewport = ? AND label = ?
  `).get(input.monitorId, input.pageUrl, viewport, label);

  return rowToBaseline(row);
}

/**
 * Get the newest baseline for a (monitorId, pageUrl, viewport, label) key.
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

export function getBaselineById(id, db = getDatabase()) {
  const row = db.prepare('SELECT * FROM baselines WHERE id = ?').get(Number(id));
  return rowToBaseline(row);
}

export function listBaselines({ monitorId, pageUrl } = {}, db = getDatabase()) {
  const clauses = [];
  const params = [];
  if (monitorId) { clauses.push('monitor_id = ?'); params.push(monitorId); }
  if (pageUrl) { clauses.push('page_url = ?'); params.push(pageUrl); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM baselines ${where} ORDER BY created_at DESC, id DESC`).all(...params);
  return rows.map(rowToBaseline);
}

export function updateBaselineMasks(id, maskSelectors, db = getDatabase()) {
  const existing = getBaselineById(id, db);
  if (!existing) throw new Error(`Baseline not found: ${id}`);
  const cleanMasks = normalizeMaskSelectors(maskSelectors);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE baselines SET mask_selectors_json = ?, decided_at = ? WHERE id = ?
  `).run(JSON.stringify(cleanMasks), now, existing.id);
  recordBaselineDecision({
    baselineId: existing.id,
    monitorId: existing.monitorId,
    pageUrl: existing.pageUrl,
    viewport: existing.viewport,
    label: existing.label,
    action: 'masks-updated',
    maskSelectors: cleanMasks,
    decidedAt: now,
  }, db);
  return getBaselineById(existing.id, db);
}

export function recordBaselineDecision(decision, db = getDatabase()) {
  const now = decision.decidedAt || new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO baseline_decisions (
      baseline_id, monitor_id, run_id, page_url, viewport, label,
      action, mask_selectors_json, waiver_reason, waiver_expires_at, decided_by, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.baselineId ?? null,
    decision.monitorId ?? null,
    decision.runId ?? null,
    decision.pageUrl,
    decision.viewport || 'default',
    decision.label || 'default',
    decision.action,
    decision.maskSelectors ? JSON.stringify(normalizeMaskSelectors(decision.maskSelectors)) : null,
    decision.waiverReason ?? null,
    decision.waiverExpiresAt ?? null,
    decision.decidedBy ?? null,
    now
  );
  const row = db.prepare('SELECT * FROM baseline_decisions WHERE id = ?').get(info.lastInsertRowid);
  return rowToDecision(row);
}

/**
 * Approve a baseline change (promotes newPath as reference screenshot, saves
 * any edited maskSelectors, clears prior waiver, records persistent decision).
 */
export function approveBaselineReview({
  id,
  runId = null,
  newPath = null,
  newHash = null,
  maskSelectors = null,
  reason = null,
  decidedBy = 'dashboard-reviewer',
}, db = getDatabase()) {
  const existing = getBaselineById(id, db);
  if (!existing) throw new Error(`Baseline not found: ${id}`);

  const cleanMasks = maskSelectors !== null
    ? normalizeMaskSelectors(maskSelectors)
    : existing.maskSelectors;
  const effectivePath = newPath || existing.path;
  let effectiveHash = newHash || existing.hash;
  if (newPath && !newHash && fs.existsSync(newPath)) {
    try {
      effectiveHash = createHash('sha256').update(fs.readFileSync(newPath)).digest('hex').slice(0, 16);
    } catch { /* keep fallback */ }
  }
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE baselines
    SET path = ?,
        hash = ?,
        mask_selectors_json = ?,
        review_status = 'approved',
        waiver_reason = ?,
        waiver_expires_at = NULL,
        decided_at = ?,
        decided_by = ?
    WHERE id = ?
  `).run(
    effectivePath,
    effectiveHash,
    JSON.stringify(cleanMasks),
    reason || null,
    now,
    decidedBy,
    existing.id
  );

  const decision = recordBaselineDecision({
    baselineId: existing.id,
    monitorId: existing.monitorId,
    runId,
    pageUrl: existing.pageUrl,
    viewport: existing.viewport,
    label: existing.label,
    action: 'approved',
    maskSelectors: cleanMasks,
    waiverReason: reason || 'Approved visual baseline change',
    decidedBy,
    decidedAt: now,
  }, db);

  return { baseline: getBaselineById(existing.id, db), decision };
}

/**
 * Waive a visual baseline diff with a mandatory written reason and optional
 * ISO yyyy-mm-dd expiry date. Persists across subsequent runs.
 */
export function waiveBaselineReview({
  id,
  runId = null,
  reason,
  expiresAt = null,
  maskSelectors = null,
  decidedBy = 'dashboard-reviewer',
}, db = getDatabase()) {
  const existing = getBaselineById(id, db);
  if (!existing) throw new Error(`Baseline not found: ${id}`);
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) throw new Error('Waiving a visual diff requires a non-empty reason');
  if (expiresAt) {
    const expStr = String(expiresAt).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
      throw new Error(`Invalid expiresAt "${expiresAt}" — expected ISO date yyyy-mm-dd`);
    }
    const [y, m, d] = expStr.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
      throw new Error(`Invalid calendar date expiresAt "${expiresAt}"`);
    }
  }

  const cleanMasks = maskSelectors !== null
    ? normalizeMaskSelectors(maskSelectors)
    : existing.maskSelectors;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE baselines
    SET mask_selectors_json = ?,
        review_status = 'waived',
        waiver_reason = ?,
        waiver_expires_at = ?,
        decided_at = ?,
        decided_by = ?
    WHERE id = ?
  `).run(
    JSON.stringify(cleanMasks),
    trimmedReason,
    expiresAt ? String(expiresAt).trim() : null,
    now,
    decidedBy,
    existing.id
  );

  const decision = recordBaselineDecision({
    baselineId: existing.id,
    monitorId: existing.monitorId,
    runId,
    pageUrl: existing.pageUrl,
    viewport: existing.viewport,
    label: existing.label,
    action: 'waived',
    maskSelectors: cleanMasks,
    waiverReason: trimmedReason,
    waiverExpiresAt: expiresAt ? String(expiresAt).trim() : null,
    decidedBy,
    decidedAt: now,
  }, db);

  return { baseline: getBaselineById(existing.id, db), decision };
}

export function listBaselineDecisions({ baselineId, monitorId, runId } = {}, db = getDatabase()) {
  const clauses = [];
  const params = [];
  if (baselineId != null) { clauses.push('baseline_id = ?'); params.push(Number(baselineId)); }
  if (monitorId) { clauses.push('monitor_id = ?'); params.push(monitorId); }
  if (runId) { clauses.push('run_id = ?'); params.push(runId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM baseline_decisions ${where} ORDER BY id DESC`).all(...params);
  return rows.map(rowToDecision);
}

/**
 * Active (unexpired) visual waivers saved via dashboard baseline review for a
 * monitor/scope, shaped for matching visual findings across runs.
 */
export function getActiveBaselineWaivers(monitorId, db = getDatabase()) {
  if (!monitorId) return [];
  const rows = db.prepare(`
    SELECT * FROM baselines
    WHERE monitor_id = ? AND review_status = 'waived' AND waiver_reason IS NOT NULL
  `).all(monitorId);
  const out = [];
  for (const row of rows) {
    const b = rowToBaseline(row);
    if (b.waiverExpiresAt && isDateExpired(b.waiverExpiresAt)) continue;
    out.push({
      baselineId: b.id,
      monitorId: b.monitorId,
      pageUrl: b.pageUrl,
      viewport: b.viewport,
      label: b.label,
      reason: b.waiverReason,
      expiresAt: b.waiverExpiresAt,
      decidedAt: b.decidedAt,
      maskSelectors: b.maskSelectors,
    });
  }
  return out;
}

/**
 * Delete every baseline recorded for a monitor (called when the monitor is removed).
 */
export function deleteBaselinesForMonitor(monitorId, db = getDatabase()) {
  const info = db.prepare('DELETE FROM baselines WHERE monitor_id = ?').run(monitorId);
  return info.changes;
}
