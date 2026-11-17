/**
 * services/waivers.js — findings waivers with expiry
 * (.qualitypilotignore.json, Phase 10).
 *
 * A waiver says: "we know about this finding and accept it for now." Waived
 * findings stay in reports (annotated) but do not fail the gate.
 *
 * File shape:
 * {
 *   "waivers": [
 *     {
 *       "ruleId": "header-strict-transport-security",
 *       "pageUrl": "http://localhost:3000",       // optional: exact match, or '*' suffix = prefix match
 *       "reason": "localhost-only target — no TLS termination here",
 *       "expiresAt": "2026-12-31"                 // optional ISO date (yyyy-mm-dd); after it, the waiver stops applying
 *     }
 *   ]
 * }
 *
 * Rules:
 *   • ruleId (string) and reason (non-empty string) are REQUIRED — a waiver
 *     without a written reason is a liability, not a decision.
 *   • pageUrl is optional; when given it must match exactly, or end with '*'
 *     for a prefix match.
 *   • An expired waiver no longer suppresses anything, and says so loudly
 *     (warnings) — the finding surfaces again instead of hiding forever.
 *
 * Pure functions; no I/O.
 */

export function parseWaiverFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Waiver file is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Waiver file must be an object with a "waivers" array');
  }
  if (!Array.isArray(data.waivers)) {
    throw new Error('Waiver file must have a "waivers" array');
  }

  const waivers = data.waivers.map((w, i) => {
    const at = `waivers[${i}]`;
    if (!w || typeof w !== 'object') throw new Error(`${at}: not an object`);
    if (typeof w.ruleId !== 'string' || !w.ruleId.trim()) throw new Error(`${at}: "ruleId" is required`);
    if (typeof w.reason !== 'string' || !w.reason.trim()) {
      throw new Error(`${at} (${w.ruleId}): "reason" is required — a waiver without a written reason is a liability, not a decision`);
    }
    if (w.pageUrl !== undefined && typeof w.pageUrl !== 'string') throw new Error(`${at}: "pageUrl" must be a string`);
    if (w.expiresAt !== undefined) {
      if (typeof w.expiresAt !== 'string' || Number.isNaN(Date.parse(w.expiresAt))) {
        throw new Error(`${at} (${w.ruleId}): "expiresAt" must be an ISO date (yyyy-mm-dd)`);
      }
    }
    return {
      ruleId: w.ruleId.trim(),
      ...(w.pageUrl ? { pageUrl: String(w.pageUrl) } : {}),
      reason: w.reason.trim(),
      ...(w.expiresAt ? { expiresAt: w.expiresAt } : {}),
    };
  });

  return { waivers };
}

function waiverMatches(waiver, finding, today) {
  const ruleId = String(finding?.ruleId || '');
  if (!ruleId || ruleId !== waiver.ruleId) return false;

  if (waiver.pageUrl) {
    const pageUrl = String(finding?.pageUrl || '');
    if (waiver.pageUrl.endsWith('*')) {
      if (!pageUrl.startsWith(waiver.pageUrl.slice(0, -1))) return false;
    } else if (pageUrl !== waiver.pageUrl) {
      return false;
    }
  }

  if (waiver.expiresAt) {
    // Expired waivers match nothing — but the caller wants to know when one
    // would have matched, so report it via a sentinel the caller checks.
    const expiry = new Date(waiver.expiresAt);
    const now = today instanceof Date ? today : new Date(today);
    if (!Number.isNaN(now.getTime()) && now > expiry) return 'expired';
  }
  return true;
}

/**
 * Split findings into kept vs waived.
 *
 * @param {object[]} findings
 * @param {object[]} waivers       — parsed waivers
 * @param {object} [opts]
 * @param {Date|string} [opts.today] — clock override for expiry checks (tests)
 * @returns {{ kept: object[], waived: object[], warnings: string[] }}
 *   kept and waived reference the SAME finding objects (annotate `waived`
 *   fields on them if desired); warnings are loud strings for the stderr log.
 */
export function applyWaivers(findings, waivers, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const rules = Array.isArray(waivers) ? waivers : [];
  const today = opts.today ?? new Date();

  const kept = [];
  const waived = [];
  const warnings = [];

  for (const finding of list) {
    let applied = null;
    for (const waiver of rules) {
      const match = waiverMatches(waiver, finding, today);
      if (match === true) { applied = waiver; break; }
      if (match === 'expired' && !applied) {
        warnings.push(
          `EXPIRED WAIVER: "${waiver.reason}" (ruleId ${waiver.ruleId}, expired ${waiver.expiresAt}) no longer suppresses "${finding.title}" — the finding is live again. Update or remove the waiver.`,
        );
        // keep scanning other waivers — a non-expired one may still cover it
      }
    }
    if (applied) waived.push(finding);
    else kept.push(finding);
  }

  return { kept, waived, warnings };
}
