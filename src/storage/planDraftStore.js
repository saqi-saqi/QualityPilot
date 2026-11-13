/**
 * storage/planDraftStore.js — SQLite persistence for AI-drafted test plans
 * awaiting human review (human-in-the-loop gate).
 *
 * Flow: runManager.draftPlan(url) → saveDraft(url, plan) → dashboard shows the
 * plan → reviewer approves → POST /api/runs { planDraftId } → getDraft +
 * markApproved → createRunWithMatrix executes the approved plan.
 *
 * Drafts expire after 24h — purged lazily on read (no background timer).
 */
import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function safeParse(jsonStr, fallback = null) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

function rowToDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    plan: safeParse(row.plan_json, null),
    status: row.status || 'draft',
    createdAt: row.created_at,
  };
}

/** Lazy purge: drop drafts older than the 24h TTL. Called on every read. */
function purgeExpired(db, now = Date.now()) {
  const cutoff = new Date(now - DRAFT_TTL_MS).toISOString();
  db.prepare('DELETE FROM plan_drafts WHERE created_at < ?').run(cutoff);
}

/**
 * Persist a draft plan. Returns the generated draft id.
 * @param {string} url — target URL the plan was drafted for
 * @param {object} planJson — the TestPlan object (or pre-serialized JSON string)
 * @param {object} [db]
 * @returns {string} draftId
 */
export function saveDraft(url, planJson, db = getDatabase()) {
  const id = `draft_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const serialized = planJson == null ? null : (typeof planJson === 'string' ? planJson : JSON.stringify(planJson));
  const stmt = db.prepare(`
    INSERT INTO plan_drafts (id, url, plan_json, status, created_at)
    VALUES (?, ?, ?, 'draft', ?)
  `);
  stmt.run(id, url || null, serialized, new Date().toISOString());
  return id;
}

/**
 * Fetch a draft by id. Expired drafts are purged first, so a stale id
 * behaves exactly like an unknown id (null).
 * @returns {object|null} { id, url, plan, status, createdAt }
 */
export function getDraft(id, db = getDatabase()) {
  purgeExpired(db);
  const row = db.prepare('SELECT * FROM plan_drafts WHERE id = ?').get(id);
  return rowToDraft(row);
}

/**
 * Mark a draft approved — the human-in-the-loop gate before execution.
 * @returns {boolean} true when an existing draft was transitioned
 */
export function markApproved(id, db = getDatabase()) {
  purgeExpired(db);
  const info = db.prepare(`
    UPDATE plan_drafts SET status = 'approved' WHERE id = ? AND status = 'draft'
  `).run(id);
  if (info.changes > 0) return true;
  // Already-approved drafts: idempotent approve → still true when it exists.
  const row = db.prepare('SELECT status FROM plan_drafts WHERE id = ?').get(id);
  return Boolean(row && row.status === 'approved');
}

/**
 * List recent drafts, newest first.
 * @param {number} [limit=50]
 * @param {object} [db]
 * @returns {Array<{ id, url, plan, status, createdAt }>}
 */
export function listDrafts(limit = 50, db = getDatabase()) {
  purgeExpired(db);
  const effectiveLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = db.prepare(
    'SELECT * FROM plan_drafts ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(effectiveLimit);
  return rows.map(rowToDraft);
}
