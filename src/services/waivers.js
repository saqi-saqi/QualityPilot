/**
 * services/waivers.js — findings waivers with expiry.
 *
 * A waiver says: "we know about this finding and accept it for now." Waived
 * findings stay in reports (annotated) but do not fail the gate.
 *
 * The conventional file name is `.qualitypilotignore.json`; it is loaded
 * explicitly via `qualitypilot check --ignore-file <file>` (there is no
 * auto-discovery — CI should always see exactly the waivers it was given).
 *
 * File shape:
 * {
 *   "waivers": [
 *     {
 *       "ruleId": "header-strict-transport-security",
 *       "pageUrl": "http://localhost:3000",       // optional scope; trailing '*' = path-prefix
 *       "reason": "localhost-only target — no TLS termination here",
 *       "expiresAt": "2026-12-31",                // optional ISO date, inclusive through the end of the stated UTC day
 *       "method": "GET",                          // optional exact HTTP method (API findings)
 *       "selector": "#cancel",                    // optional exact element selector (a11y/console findings)
 *       "role": "admin",                          // optional scan context — one of the matrix roles
 *       "roles": ["admin", "editor"]              // …or several (use either "role" or "roles", not both)
 *     }
 *   ]
 * }
 *
 * Rules:
 *   • ruleId (string) and reason (non-empty string) are REQUIRED — a waiver
 *     without a written reason is a liability, not a decision.
 *   • Unknown keys are REJECTED. A typo in a scope key ("rolez": "admin")
 *     used to be dropped silently, which turned a narrowly scoped waiver
 *     into a global one — the exact failure mode this file must never have.
 *   • pageUrl matches by ORIGIN + PATH: scheme and host are case-insensitive,
 *     default ports (:80/:443) are equal to none, trailing slashes are
 *     ignored, fragments are ignored. Query strings are ignored unless the
 *     waiver itself specifies one. A trailing '*' is a PATH-PREFIX scope at a
 *     segment boundary ("/account*" covers /account and /account/settings,
 *     never /account-deletion) and can never cross the origin
 *     ("https://shop.test*" does not match shop.test.attacker.example).
 *     Omitting pageUrl entirely means "every URL"; a blank pageUrl is an
 *     error, not a silent global.
 *   • role/roles scope the waiver to scan contexts. A role-scoped waiver only
 *     suppresses a finding observed in EVERY role it covers — a waiver scoped
 *     to the admin context never hides the same defect seen anonymously.
 *     Findings without role information are never suppressed by a
 *     role-scoped waiver (fail-safe).
 *   • An expired waiver no longer suppresses anything, and says so loudly
 *     (warnings) — the finding surfaces again instead of hiding forever.
 *
 * Pure functions; no I/O.
 */

/** Keys a waiver may carry — anything else is a parse error. */
const ALLOWED_KEYS = ['ruleId', 'pageUrl', 'reason', 'expiresAt', 'method', 'selector', 'role', 'roles'];

/** Strict ISO calendar date: also rejects impossible dates like 2026-02-31. */
function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Parse a pageUrl scope: `{ wildcard, origin, path, search }` or null.
 * Origin equality comes from the URL parser (case-folded host, default
 * ports normalized), so "https://shop.test:443/x" and "https://shop.test/x"
 * are the same scope.
 */
function parsePageUrlScope(raw) {
  const value = String(raw);
  const wildcard = value.endsWith('*');
  const base = wildcard ? value.slice(0, -1) : value;
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  let search = '';
  if (u.search) {
    const params = [...u.searchParams.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1);
    search = new URLSearchParams(params).toString();
  }
  return { wildcard, origin: u.origin, path, search };
}

/** Segment-boundary prefix: "/account" covers /account and /account/x, never /account-deletion. */
function pathPrefixMatch(prefix, path) {
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith('/') || path.length === prefix.length || path[prefix.length] === '/';
}

function urlScopeMatches(scope, findingUrl) {
  if (!scope) return true; // no pageUrl key → every URL
  const f = parsePageUrlScope(String(findingUrl || ''));
  if (!f) return false; // unusable finding URL → only a global waiver may cover it
  if (scope.origin !== f.origin) return false;
  if (scope.wildcard ? !pathPrefixMatch(scope.path, f.path) : scope.path !== f.path) return false;
  if (scope.search && scope.search !== f.search) return false;
  return true;
}

/** Roles a finding was observed in: merged `roles` array, else the cell/finding role. */
function findingRoles(finding) {
  if (Array.isArray(finding?.roles) && finding.roles.length > 0) {
    return finding.roles.map((r) => String(r));
  }
  const single = finding?.matrixCell?.role ?? finding?.role;
  return single ? [String(single)] : [];
}

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
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error(`${at}: not an object`);
    for (const key of Object.keys(w)) {
      if (!ALLOWED_KEYS.includes(key)) {
        throw new Error(`${at}: unknown key "${key}" — allowed: ${ALLOWED_KEYS.join(', ')}. A misspelled scope key would silently widen the waiver.`);
      }
    }
    if (typeof w.ruleId !== 'string' || !w.ruleId.trim()) throw new Error(`${at}: "ruleId" is required`);
    if (typeof w.reason !== 'string' || !w.reason.trim()) {
      throw new Error(`${at} (${w.ruleId}): "reason" is required — a waiver without a written reason is a liability, not a decision`);
    }
    const ruleId = w.ruleId.trim();

    // pageUrl: an explicit scope only. Blank/whitespace is an error — it used
    // to be dropped, silently promoting the waiver to "every URL".
    let pageUrl;
    if (w.pageUrl !== undefined) {
      if (typeof w.pageUrl !== 'string' || !w.pageUrl.trim()) {
        throw new Error(`${at} (${ruleId}): "pageUrl" must be a non-empty URL — omit the key entirely to cover every URL`);
      }
      if (!parsePageUrlScope(w.pageUrl)) {
        throw new Error(`${at} (${ruleId}): "pageUrl" is not an http(s) URL: "${w.pageUrl}"`);
      }
      pageUrl = w.pageUrl;
    }

    let method;
    if (w.method !== undefined) {
      if (typeof w.method !== 'string' || !/^[A-Za-z]+$/.test(w.method.trim())) {
        throw new Error(`${at} (${ruleId}): "method" must be an HTTP method token like "GET"`);
      }
      method = w.method.trim().toUpperCase();
    }

    let selector;
    if (w.selector !== undefined) {
      if (typeof w.selector !== 'string' || !w.selector.trim()) {
        throw new Error(`${at} (${ruleId}): "selector" must be a non-empty string`);
      }
      selector = w.selector;
    }

    let roles;
    if (w.roles !== undefined || w.role !== undefined) {
      const raw = w.roles !== undefined ? w.roles : [w.role];
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((r) => typeof r === 'string' && r.trim())) {
        throw new Error(`${at} (${ruleId}): "roles" must be a non-empty array of role names (or use "role": "<name>")`);
      }
      roles = [...new Set(raw.map((r) => r.trim()))];
    }

    let expiresAt;
    if (w.expiresAt !== undefined) {
      if (!parseIsoDate(w.expiresAt)) {
        throw new Error(`${at} (${ruleId}): "expiresAt" must be an ISO date (yyyy-mm-dd)`);
      }
      expiresAt = w.expiresAt;
    }

    return {
      ruleId,
      ...(pageUrl ? { pageUrl } : {}),
      ...(method ? { method } : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(roles ? { roles } : {}),
      reason: w.reason.trim(),
      ...(expiresAt ? { expiresAt } : {}),
    };
  });

  // Two waivers with the same ruleId and the same scope are a conflict, not
  // a preference — the file order used to decide silently.
  const seen = new Map();
  waivers.forEach((w, i) => {
    const key = [w.ruleId, w.pageUrl || '*', w.method || '*', w.selector || '*', (w.roles || []).join(',')].join('|');
    if (seen.has(key)) {
      throw new Error(`waivers[${i}]: duplicates waivers[${seen.get(key)}] (same ruleId and scope) — remove one of them`);
    }
    seen.set(key, i);
  });

  return { waivers };
}

function waiverMatches(waiver, finding, today) {
  const ruleId = String(finding?.ruleId || '');
  if (!ruleId || ruleId !== waiver.ruleId) return false;

  if (!urlScopeMatches(waiver.pageUrl ? parsePageUrlScope(waiver.pageUrl) : null, finding?.pageUrl)) {
    return false;
  }

  // method: a GET-scoped waiver must never cover the POST finding, and a
  // finding with no method information is never covered by a method-scoped
  // waiver (fail-safe).
  if (waiver.method) {
    const fm = String(finding?.method || '').toUpperCase();
    if (!fm || fm !== waiver.method) return false;
  }

  // selector: when the waiver names an element, only that element is covered.
  if (waiver.selector !== undefined) {
    const fsel = finding?.selector == null ? '' : String(finding.selector);
    if (fsel !== waiver.selector) return false;
  }

  // role: a role-scoped waiver covers a finding only when every context the
  // finding was observed in is within the waiver's scope.
  if (waiver.roles && waiver.roles.length > 0) {
    const observed = findingRoles(finding);
    if (observed.length === 0 || !observed.every((r) => waiver.roles.includes(r))) return false;
  }

  if (waiver.expiresAt) {
    // Expired waivers match nothing — but the caller wants to know when one
    // would have matched, so report it via a sentinel the caller checks.
    // The stated day is covered INCLUSIVELY through its final millisecond in
    // UTC (a plain new Date("yyyy-mm-dd") compared against "now" used to
    // expire the waiver at 00:00 UTC — the morning of its own last day).
    const { y, m, d } = parseIsoDate(waiver.expiresAt);
    const endOfDayMs = Date.UTC(y, m - 1, d + 1) - 1;
    const now = today instanceof Date ? today.getTime() : new Date(today).getTime();
    if (Number.isFinite(now) && now > endOfDayMs) return 'expired';
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
