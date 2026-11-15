/**
 * export/planJson.js — portable plan JSON export.
 *
 * The exported artifact is the input for QualityPilot's CI plan replay
 * (Phase 3): the LLM/heuristics infer the plan once, and CI replays it
 * forever without any AI key. The plan is passed through `parseTestPlan`
 * on export so the artifact is always schema-valid and carries every
 * applied default — what you export is exactly what will replay.
 */

import { parseTestPlan } from '../services/testPlan.js';

export const PLAN_EXPORT_KIND = 'qualitypilot/plan';
export const PLAN_EXPORT_FORMAT_VERSION = 1;

/**
 * Export a plan (raw or already-parsed) as a portable JSON artifact.
 *
 * @param {object} plan — a QualityPilot TestPlan (raw object or parsed)
 * @param {object} [opts]
 * @param {string} [opts.source] — free-form provenance note (e.g. 'run run_123', 'dashboard draft_456')
 * @returns {{ kind: string, formatVersion: number, exportedAt: string, generator: {name: string}, source: string|null, plan: object }}
 * @throws When the plan fails TestPlan validation (error message carries the zod issues).
 */
export function exportPlanJson(plan, opts = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('exportPlanJson: plan must be an object');
  }
  // parseTestPlan normalizes (defaults applied, strict schema enforced) and
  // throws with path-tagged issue text when the plan is invalid.
  const normalized = parseTestPlan(plan);
  return {
    kind: PLAN_EXPORT_KIND,
    formatVersion: PLAN_EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    generator: { name: 'QualityPilot' },
    source: typeof opts.source === 'string' ? opts.source : null,
    plan: normalized,
  };
}

/**
 * Import a plan JSON artifact (round-trip of exportPlanJson) and return the
 * parsed TestPlan, ready for replay via createRunWithMatrix / runMatrix.
 *
 * @param {object} artifact — the parsed content of an exported plan JSON file
 * @returns {object} the normalized TestPlan
 * @throws When the envelope is missing/wrong or the embedded plan is invalid.
 */
export function importPlanJson(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('importPlanJson: artifact must be an object');
  }
  if (artifact.kind !== PLAN_EXPORT_KIND) {
    throw new Error(`importPlanJson: not a QualityPilot plan export (expected kind "${PLAN_EXPORT_KIND}", got "${String(artifact.kind)}")`);
  }
  if (!artifact.plan || typeof artifact.plan !== 'object') {
    throw new Error('importPlanJson: artifact.plan is missing');
  }
  return parseTestPlan(artifact.plan);
}
