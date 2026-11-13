/**
 * executors/selectorResolver.js — deterministic selector fallback ladder.
 *
 * When a plan's CSS/XPath selector no longer matches anything on the page
 * (selector drift — the #1 real-world E2E pain point), we try a ladder of
 * progressively looser alternatives derived from the selector itself:
 *
 *   1. the original selector, as given (CSS or XPath);
 *   2. attribute lookups: [data-testid="<name>"], [data-test="<name>"],
 *      [aria-label="<name>"] where <name> is derived from the selector's
 *      id / class / name-attribute fragments;
 *   3. the Playwright role engine: page.getByRole(<implied role>, { name })
 *      when the selector hints a role (button/link/input from tag or class);
 *   4. page.getByText(name, { exact: false }) — last resort, only when a
 *      text-ish fragment is extractable.
 *
 * The first candidate whose locator EXISTS (locator.count() > 0, raced
 * against a short timeout) wins. Fully deterministic — no LLM, no guessing
 * beyond the fragments already present in the selector.
 */

const ROLE_HINTS = [
  // [regex over the selector, Playwright role]
  [/\bbutton\b|\bbtn\b/i, 'button'],
  [/\b(link|anchor)\b|\ba\b\s*[.[#:]|a$/i, 'link'],
  [/\b(checkbox|toggle)\b/i, 'checkbox'],
  [/\b(radio)\b/i, 'radio'],
  [/\b(combobox|dropdown|select)\b/i, 'combobox'],
  [/\b(input|field|textbox|email|password|search|username)\b/i, 'textbox'],
];

/**
 * Extract a human-ish "name" from a selector: the most specific identifying
 * fragment (id, name attribute, data-testid value, or class name).
 * Examples:
 *   '#login-btn'              → 'login-btn'
 *   'input[name="email"]'     → 'email'
 *   'form .submit-button'     → 'submit-button'
 *   '[data-testid="checkout"]'→ 'checkout'
 * Returns null when nothing extractable.
 */
export function extractSelectorName(selector) {
  if (typeof selector !== 'string' || !selector.trim()) return null;
  const patterns = [
    /\[data-testid=["']?([^\]"' ]+)["']?\]/i,
    /\[data-test=["']?([^\]"' ]+)["']?\]/i,
    /#([A-Za-z_][\w-]*)/,                       // id
    /\[name=["']?([^\]"' ]+)["']?\]/i,          // name attribute value
    /\[aria-label=["']?([^\]"' ]+)["']?\]/i,
    /\.([A-Za-z_][\w-]*)/,                      // first class fragment
  ];
  for (const re of patterns) {
    const m = selector.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Infer the Playwright ARIA role implied by the selector's tag/class names.
 * Returns 'button' | 'link' | 'textbox' | ... | null (no confident hint).
 */
export function inferRoleFromSelector(selector) {
  if (typeof selector !== 'string') return null;
  for (const [re, role] of ROLE_HINTS) {
    if (re.test(selector)) return role;
  }
  return null;
}

/**
 * Build the ordered candidate ladder for a selector (excluding the original).
 * Returns [{ selector, kind }] — kind: 'attr' | 'role' | 'text'.
 */
export function buildFallbackCandidates(selector) {
  const candidates = [];
  const name = extractSelectorName(selector);
  if (!name) return candidates;

  for (const attr of ['data-testid', 'data-test', 'aria-label']) {
    candidates.push({ selector: `[${attr}="${name}"]`, kind: 'attr' });
  }

  const role = inferRoleFromSelector(selector);
  if (role) {
    candidates.push({ role, name, kind: 'role' });
  }

  candidates.push({ text: name, kind: 'text' });
  return candidates;
}

/**
 * Probe whether a locator currently exists on the page.
 * Prefers locator.count() (instant). The ORIGINAL selector is trusted when
 * its locator API can't verify existence (e.g. simple test mocks without
 * count()); fallback candidates must verify via a short waitFor probe.
 */
async function locatorExists(locator, timeoutMs, trustUnverifiable = false) {
  if (!locator) return false;
  if (typeof locator.count === 'function') {
    try {
      const count = await withTimeout(locator.count(), timeoutMs);
      return count > 0;
    } catch {
      return false;
    }
  }
  if (trustUnverifiable) return true;
  if (typeof locator.waitFor === 'function') {
    try {
      await locator.waitFor({ state: 'attached', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('existence probe timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function locatorForCandidate(page, candidate, originalSelector) {
  switch (candidate.kind) {
    case 'original':
      return typeof page.locator === 'function' ? page.locator(originalSelector) : null;
    case 'attr':
      return typeof page.locator === 'function' ? page.locator(candidate.selector) : null;
    case 'role':
      return typeof page.getByRole === 'function' ? page.getByRole(candidate.role, { name: candidate.name }) : null;
    case 'text':
      return typeof page.getByText === 'function' ? page.getByText(candidate.text, { exact: false }) : null;
    default:
      return null;
  }
}

function describeCandidate(candidate) {
  switch (candidate.kind) {
    case 'original': return candidate.selector;
    case 'attr': return candidate.selector;
    case 'role': return `getByRole('${candidate.role}', { name: '${candidate.name}' })`;
    case 'text': return `getByText('${candidate.text}')`;
    default: return String(candidate);
  }
}

/**
 * Resolve a selector to a live locator using the fallback ladder.
 *
 * @param {object} page      — Playwright Page (or mock)
 * @param {string} selector  — CSS/XPath selector from the plan
 * @param {object} [opts]
 * @param {number} [opts.existenceTimeoutMs=1000] — per-candidate existence probe timeout
 * @returns {Promise<{locator: object|null, selector: string, healed: boolean, ladder: Array<{candidate: string, found: boolean}>}>}
 *   The winning locator + metadata. When NOTHING on the ladder exists,
 *   `locator` is null (caller should run the original selector anyway so
 *   Playwright produces its familiar timeout error, and report the ladder
 *   in evidence).
 */
export async function resolveLocatorDetailed(page, selector, opts = {}) {
  const failure = (ladder) => ({ locator: null, selector: typeof selector === 'string' ? selector : '', healed: false, ladder });
  if (!page || typeof selector !== 'string' || !selector.trim()) return failure([]);
  const timeoutMs = opts.existenceTimeoutMs ?? 1000;

  const candidates = [{ selector, kind: 'original' }, ...buildFallbackCandidates(selector)];
  const ladder = [];

  for (const candidate of candidates) {
    const locator = locatorForCandidate(page, candidate, selector);
    const isOriginal = candidate.kind === 'original';
    const found = await locatorExists(locator, timeoutMs, /* trustUnverifiable */ isOriginal);
    ladder.push({ candidate: describeCandidate(candidate), found });
    if (found && locator) {
      return {
        locator,
        selector: isOriginal ? selector : describeCandidate(candidate),
        healed: !isOriginal,
        ladder,
      };
    }
  }
  return failure(ladder);
}

/**
 * Spec-simple API: return the first locator on the ladder that exists, else
 * null. (resolveLocatorDetailed exposes which rung matched.)
 */
export async function resolveLocator(page, selector, opts = {}) {
  const resolved = await resolveLocatorDetailed(page, selector, opts);
  return resolved ? resolved.locator : null;
}
