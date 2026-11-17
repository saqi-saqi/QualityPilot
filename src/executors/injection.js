/**
 * executors/injection.js — differential SQL-injection + DOM-XSS sink probe.
 *
 * Three bounded probes, each backed by a signal that was VERIFIED against the
 * pinned Juice Shop target before this detector was written (2026-11-17):
 *
 *   A. GET query-param differential — mutate a captured query param with a
 *      clause-closing payload; a 5xx and/or a SQL error signature in the body
 *      is the signal. (Juice Shop: `/rest/products/search?q=')` → 500 +
 *      "SQLITE_ERROR".) Baseline must be healthy — a broken baseline has no
 *      differential to measure.
 *   B. Login-form auth bypass — submit the login form twice (benign values,
 *      then a tautology payload) and compare the login XHR status. A 4xx
 *      baseline turning into 2xx is an authentication bypass. (Juice Shop:
 *      401 → 200 + token.) The mutated response body is never captured — it
 *      contains credentials.
 *   C. Search-route DOM sink — when the plan captured a search endpoint, load
 *      the SPA search route with an executable-markup payload and check
 *      whether the raw payload became LIVE DOM. (Juice Shop: the query is
 *      reflected unescaped into #searchValue → iframe in the DOM.)
 *
 * SAFETY MODEL: active probing (this whole executor) runs by default ONLY on
 * loopback targets — the developer's own machine. Non-loopback targets
 * require the explicit `--authorized` flag (ctx.options.authorizedTarget).
 * Payloads are non-destructive: clause closers and a tautology; no DROP, no
 * stacked statements. Login sessions created by probe B die with the cell's
 * browser context. Account-creation pages (register/signup) are excluded —
 * probes must not create data.
 */

import { matchSqlError, isLoopbackUrl } from '../security/injectionSignatures.js';

/** Clause-closing probes: surface SQL errors / change the result set. */
const SQLI_PARAM_PAYLOADS = [
  { kind: 'error-probe', value: "')" },
  { kind: 'comment-tautology', value: "'))--" },
];

/** The canonical tautology — authentication bypass (verified: 401 → 200). */
const AUTH_BYPASS_PAYLOAD = "' OR 1=1--";

/** Executable-markup payload; the marker never fires alert() in headless. */
const DOM_XSS_PAYLOAD = '<iframe src="javascript:qp_dom_xss_probe"></iframe>';
const DOM_XSS_MARKER = 'qp_dom_xss_probe';

const MAX_ENDPOINTS = 10;
const MAX_PARAMS = 4;
const MAX_LOGIN_FORMS = 2;

function statusClass(status) {
  if (status == null) return 'none';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

export default async function injectionExecutor(ctx) {
  const findings = [];
  const stats = {
    endpointsProbed: 0,
    loginFormsProbed: 0,
    searchDomProbed: false,
    skippedNotAuthorized: false,
  };

  const plan = ctx.plan || {};
  const targetUrl = plan.targetUrl;
  if (!targetUrl) return { findings, stats };

  const authorized = ctx.options?.authorizedTarget === true;
  const loopback = isLoopbackUrl(targetUrl);
  if (!loopback && !authorized) {
    stats.skippedNotAuthorized = true;
    ctx.onEvent?.('injection skipped — active probing on non-loopback targets requires authorization');
    return { findings, stats };
  }

  const fetchImpl = ctx.options?.fetch || globalThis.fetch;
  const timeoutMs = ctx.options?.timeout ?? 10000;

  // ─── A. GET query-param differential ────────────────────────────────
  const queryEndpoints = (plan.apiEndpoints || []).filter(
    (e) => e.method === 'GET' && e.queryParams && Object.keys(e.queryParams).length > 0,
  );

  for (const endpoint of queryEndpoints.slice(0, MAX_ENDPOINTS)) {
    if (ctx.signal?.aborted) break;
    const base = originOf(endpoint.baseUrl || targetUrl) || originOf(targetUrl);
    if (!base || !fetchImpl) break;

    const params = Object.keys(endpoint.queryParams).slice(0, MAX_PARAMS);
    for (const param of params) {
      if (ctx.signal?.aborted) break;

      // Baseline must be healthy — otherwise there is no differential.
      let baseline;
      try {
        const res = await fetchImpl(`${base}${endpoint.path}?${new URLSearchParams(endpoint.queryParams).toString()}`, {
          signal: ctx.signal, redirect: 'follow',
        });
        const body = await res.text();
        baseline = { status: res.status, len: body.length };
      } catch {
        continue; // unreachable endpoint — the crawler already reports it
      }
      stats.endpointsProbed++;
      if (baseline.status >= 500) continue;

      for (const payload of SQLI_PARAM_PAYLOADS) {
        if (ctx.signal?.aborted) break;
        const qs = new URLSearchParams({ ...endpoint.queryParams, [param]: payload.value }).toString();

        let mutated;
        try {
          const res = await fetchImpl(`${base}${endpoint.path}?${qs}`, { signal: ctx.signal, redirect: 'follow' });
          const body = await res.text();
          mutated = { status: res.status, len: body.length, signature: matchSqlError(body), snippet: body.slice(0, 200) };
        } catch {
          continue;
        }

        const crashed = mutated.status >= 500;
        const bypassed = statusClass(baseline.status) !== '2xx' && statusClass(mutated.status) === '2xx';
        const signals = [];
        if (crashed) signals.push(`status ${baseline.status} → ${mutated.status} (5xx)`);
        if (mutated.signature) signals.push(`SQL error signature (${mutated.signature.vendor}: ${mutated.signature.match})`);
        if (bypassed) signals.push(`status ${baseline.status} → ${mutated.status} (2xx with mutated input)`);
        if (signals.length === 0) continue;

        const ruleId = bypassed ? 'injection-sqli' : 'injection-sqli-error';
        const confirmed = bypassed || signals.length >= 2;
        findings.push(ctx.createFinding({
          title: `SQL injection signal: ${endpoint.method} ${endpoint.path} param "${param}"`,
          severity: bypassed ? 'high' : 'medium',
          confidence: confirmed ? 'confirmed' : 'suspected',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId,
          pageUrl: `${base}${endpoint.path}`,
          description: `Mutating query param "${param}" with ${JSON.stringify(payload.value)} (${payload.kind}) produced: ${signals.join('; ')}. Baseline ${baseline.status} (${baseline.len}B).`,
          evidence: `Payload: ${payload.value}\nSignals: ${signals.join(' | ')}\nResponse (200B): ${String(mutated.snippet).replace(/\s+/g, ' ')}`,
          suggestedFix: 'Use parameterized queries and return a generic 400 for malformed input — never let SQL errors reach the client.',
        }));
        break; // one finding per param — don't stack payload variants after a hit
      }
    }
  }

  // ─── B. Login-form auth bypass (browser submit differential) ────────
  const formTargets = (plan.fuzzTargets || []).filter((t) => t.pageUrl && t.fieldSelector);
  const loginPages = new Map(); // pageUrl → { passwordField, emailField }
  for (const t of formTargets) {
    if (!/password/i.test(t.fieldSelector)) continue;
    if (/register|signup|sign-up/i.test(t.pageUrl)) continue; // account creation is data mutation — never probe it
    if (!loginPages.has(t.pageUrl)) loginPages.set(t.pageUrl, { passwordField: t.fieldSelector, emailField: null });
  }
  // Email-field selection: PREFER an email/user-named field. The first
  // non-password target on a page is often the NAVBAR SEARCH input (Phase 8
  // miss: filling it searched instead of logging in, so both attempts 401'd
  // and the bypass signal never appeared).
  const emailish = (selector) => /email|user(name)?|login/i.test(String(selector || ''));
  const looksLikeSearch = (selector) => /search|query/i.test(String(selector || ''));
  for (const t of formTargets) {
    const form = loginPages.get(t.pageUrl);
    if (!form || /password/i.test(t.fieldSelector)) continue;
    if (emailish(t.fieldSelector) && !looksLikeSearch(t.fieldSelector)) {
      form.emailField = t.fieldSelector;
    } else if (!form.emailField && !looksLikeSearch(t.fieldSelector)) {
      form.emailField = t.fieldSelector; // fallback — may be refined by a later email-named target
    }
  }
  for (const t of formTargets) {
    const form = loginPages.get(t.pageUrl);
    if (form && !/password/i.test(t.fieldSelector) && emailish(t.fieldSelector) && !looksLikeSearch(t.fieldSelector)) {
      form.emailField = t.fieldSelector; // an email-named target always wins, regardless of order
    }
  }

  if (ctx.context && loginPages.size > 0) {
    for (const [pageUrl, form] of [...loginPages.entries()].slice(0, MAX_LOGIN_FORMS)) {
      if (ctx.signal?.aborted) break;
      const page = await ctx.context.newPage();
      try {
        const loginStatuses = [];
        page.on('response', (response) => {
          try {
            const req = response.request();
            if (req.method() === 'POST' && /login|user|auth|session/i.test(response.url())) {
              loginStatuses.push(response.status());
            }
          } catch { /* response already gone */ }
        });

        const submitWith = async (emailValue) => {
          loginStatuses.length = 0;
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          const emailSelector = form.emailField || 'input[type="email"], input[name="email"]';
          await page.locator(emailSelector).first().fill(emailValue, { timeout: timeoutMs }).catch(() => {});
          const pw = page.locator(form.passwordField).first();
          await pw.fill('Passw0rd!', { timeout: timeoutMs }).catch(() => {});
          await pw.press('Enter', { timeout: timeoutMs }).catch(() => {});
          await page.waitForTimeout(1500); // let the login XHR land
          return loginStatuses.length ? Math.max(...loginStatuses) : null;
        };

        const baselineStatus = await submitWith('test@example.com');
        const mutatedStatus = await submitWith(AUTH_BYPASS_PAYLOAD);
        stats.loginFormsProbed++;

        const bypassed = baselineStatus != null && baselineStatus >= 400
          && mutatedStatus != null && mutatedStatus < 300;
        ctx.onEvent?.(`login probe ${pageUrl}: baseline ${baselineStatus ?? 'n/a'}, tautology ${mutatedStatus ?? 'n/a'} → ${bypassed ? 'BYPASS' : 'no bypass'}`);

        if (bypassed) {
          findings.push(ctx.createFinding({
            title: `SQL injection auth bypass: login form on ${pageUrl}`,
            severity: 'high',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'injection-sqli',
            pageUrl,
            description: `Submitting the login form with email ${JSON.stringify(AUTH_BYPASS_PAYLOAD)} changed the login response from ${baselineStatus} to ${mutatedStatus} — the tautology bypassed authentication. The mutated response body is deliberately NOT captured (it contains credentials).`,
            evidence: `Baseline email → HTTP ${baselineStatus}; tautology email → HTTP ${mutatedStatus}`,
            suggestedFix: 'Parameterize the login query (prepared statements) and return a generic failure message for bad credentials.',
          }));
        }
      } catch (err) {
        // Silent swallowing here would hide detector bugs (a TDZ reference in
        // the probe logic was invisible for exactly this reason — Phase 8).
        ctx.onEvent?.(`login probe on ${pageUrl} failed: ${err?.message || err}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  // ─── C. Search-route DOM sink probe ─────────────────────────────────
  const searchEndpoint = (plan.apiEndpoints || []).find((e) => /search|query/i.test(String(e.path || '')));
  if (ctx.context && searchEndpoint && !ctx.signal?.aborted) {
    const page = await ctx.context.newPage();
    try {
      stats.searchDomProbed = true;
      const route = `${targetUrl.replace(/\/$/, '')}/#/search?q=${encodeURIComponent(DOM_XSS_PAYLOAD)}`;
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(2500); // SPA render + search request
      const reflected = await page.evaluate(
        (marker) => document.documentElement.innerHTML.includes(marker),
        DOM_XSS_MARKER,
      );
      if (reflected) {
        const snippet = await page.evaluate((marker) => {
          const html = document.documentElement.innerHTML;
          const idx = html.indexOf(marker);
          return html.slice(Math.max(0, idx - 120), idx + 80);
        }, DOM_XSS_MARKER);
        findings.push(ctx.createFinding({
          title: `DOM XSS: search query reflected into executable markup (${searchEndpoint.path})`,
          severity: 'high',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: 'injection-xss-dom',
          pageUrl: route.split('?')[0],
          description: 'The search query is reflected into the document as LIVE markup — the raw <iframe src="javascript:…"> payload became a real DOM element. An attacker controls executable HTML at this sink.',
          evidence: `DOM around the sink: ${snippet}`,
          suggestedFix: 'Render the query with textContent (or HTML-escape it) — never interpolate raw user input into innerHTML.',
        }));
      }
    } catch {
      /* render never completed — no finding */
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`injection complete: ${findings.length} findings`);
  return { findings, stats };
}
