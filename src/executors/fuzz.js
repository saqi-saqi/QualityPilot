/**
 * executors/fuzz.js — input mutation + boundary testing.
 *
 * Consumes: plan.fuzzTargets[]
 * Produces: findings when fuzzed inputs cause 5xx, crashes, or contract violations
 *
 * Supports two target types (matches FuzzTarget schema):
 *   • Page form inputs  — drives Playwright (or mock page) to fill + submit
 *   • API fields        — sends requests with mutated body fields
 *
 * Generators are pure functions returning a string or array of strings.
 * Each generator is unit-testable in isolation.
 */

// ─── generators ──────────────────────────────────────────────────────

export const generators = {
  empty: () => '',
  oversize: () => 'A'.repeat(10_000),
  unicode: () => '¹²³üñîçødé Ω≈ç√∫˜µ åß∂ƒ©˙∆∆',
  sql: () => [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "admin'--",
    "' UNION SELECT * FROM users--",
  ],
  xss: () => [
    '<script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
  ],
  path: () => [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2f',
    '/etc/passwd',
  ],
  'numeric-overflow': () => String(Number.MAX_SAFE_INTEGER + 1),
  negative: () => '-1',
  'null-byte': () => 'foo\0bar',
  // Exactly 10 alphanumeric chars. The old Math.random().toString(36).slice(2, 12)
  // could return FEWER than 10 (a double's base-36 expansion can terminate early —
  // measured ~0.76% of calls), which flaked the length assertion.
  random: () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  },
};

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Generate all test inputs for a single FuzzTarget.
 * Returns an array of { generator, value, index } entries.
 * For multi-value generators (sql, xss, path) we expand to one entry per value.
 */
export function generateInputs(target) {
  const inputs = [];
  for (const genName of target.generators) {
    const gen = generators[genName];
    if (!gen) continue;
    const value = gen();
    if (Array.isArray(value)) {
      value.forEach((v, i) => inputs.push({ generator: `${genName}#${i}`, value: v }));
    } else {
      inputs.push({ generator: genName, value });
    }
  }
  // Cap iterations
  return inputs.slice(0, target.iterations);
}

/**
 * Determine if a fuzz response is acceptable per the target's expectStatus policy.
 *   'any-2xx-or-4xx'  → status in 2xx or 4xx range
 *   'no-5xx'          → status < 500
 *   'no-crash'        → status < 500 AND no exception thrown
 */
export function isAcceptableOutcome(status, threw, expectStatus = 'no-5xx') {
  if (threw) return expectStatus === 'no-crash' ? false : expectStatus !== 'no-5xx' ? status != null && status < 500 : false;
  if (expectStatus === 'any-2xx-or-4xx') return (status >= 200 && status < 300) || (status >= 400 && status < 500);
  if (expectStatus === 'no-5xx') return status == null || status < 500;
  if (expectStatus === 'no-crash') return status == null || status < 500;
  return true;
}

// ─── API fuzz runner ─────────────────────────────────────────────────

/**
 * Fuzz a single API field with a single value.
 * Looks up the endpoint in ctx.plan.apiEndpoints by path.
 */
export async function fuzzApiField(target, value, ctx) {
  const endpoint = ctx.plan.apiEndpoints.find(e => e.path === target.apiEndpointRef);
  if (!endpoint) {
    throw new Error(`Fuzz target references unknown endpoint: ${target.apiEndpointRef}`);
  }
  if (!['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    return { status: null, threw: false, skipped: true };
  }

  const fetchImpl = ctx.options?.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('No fetch available');

  const fallbackOrigin = (() => {
    try { return new URL(ctx.plan.targetUrl).origin; } catch { return ctx.plan.targetUrl; }
  })();
  const url = endpoint.baseUrl || fallbackOrigin + endpoint.path;

  const body = { ...(endpoint.body || {}) };
  body[target.field] = value;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.options?.timeout ?? 10000);
    if (ctx.signal) ctx.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const response = await fetchImpl(url, {
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json', ...endpoint.headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { status: response.status, threw: false };
  } catch (err) {
    const msg = err?.message || String(err);
    // Phase 0 Fix E2: timeout/abort/DNS failures are flagged here so the
    // finding-creation path can classify them suspected/environmental instead
    // of confirmed bugs. Genuine 5xx/crash outcomes are unaffected.
    return {
      status: null,
      threw: true,
      error: msg,
      environmental: /timeout|abort|econnrefused|enotfound|eai_again|getaddrinfo|dns/i.test(msg),
    };
  }
}

/**
 * Exercise a browser form field with a single mutated value. By default this
 * never submits the form, so it can detect client-side crashes without
 * changing server data. Submission is available only for explicitly
 * authorized active scans and an explicitly supplied submit selector.
 */
export async function fuzzFormField(target, value, ctx) {
  if (!ctx.context) return { status: null, threw: false, skipped: true, reason: 'no-browser-context' };

  const page = await ctx.context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  let responseStatus = null;

  try {
    const initialResponse = await page.goto(target.pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: ctx.options?.timeout ?? 10000,
    });
    if (initialResponse?.status) responseStatus = initialResponse.status();

    if (typeof page.on === 'function') {
      page.on('pageerror', error => pageErrors.push(error?.message || String(error)));
      page.on('console', message => {
        if (message?.type?.() === 'error') {
          // Phase 0 Fix E2: also capture the script URL that logged the error
          // (message.location) so third-party-origin console noise can be
          // classified INFO instead of a confirmed bug.
          let url = null;
          try { url = message.location?.()?.url ?? null; } catch {}
          consoleErrors.push({ text: message.text?.() || 'Console error', url });
        }
      });
      page.on('response', response => {
        try {
          if (response.request?.().isNavigationRequest?.() || response.status() >= 500) {
            responseStatus = response.status();
          }
        } catch {}
      });
    }

    const baseLocator = page.locator(target.fieldSelector);
    const locator = typeof baseLocator.first === 'function' ? baseLocator.first() : baseLocator;
    if (typeof locator.fill !== 'function') {
      return { status: responseStatus, threw: false, skipped: true, reason: 'field-not-fillable' };
    }
    await locator.fill(value, { timeout: ctx.options?.timeout ?? 10000 });

    if (ctx.options?.allowActiveFuzz && target.submitSelector) {
      await page.locator(target.submitSelector).click({ timeout: ctx.options?.timeout ?? 10000 });
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: ctx.options?.timeout ?? 10000 }).catch(() => {});
      }
    }

    if (pageErrors.length || consoleErrors.length) {
      // Phase 0 Fix E2 — signature-first console classification: pageerror is
      // page-level (first-party by origin) and stays an error signal. Console
      // errors are attributed to the script URL that logged them; third-party
      // console noise is demoted to INFO (kept, NOT discarded — payment/auth
      // widget noise can matter) unless a first-party error is also present.
      const siteOrigin = (() => { try { return new URL(target.pageUrl).origin; } catch { return null; } })();
      const isThirdParty = (u) => {
        if (!u || !siteOrigin) return false;
        try { return new URL(u).origin !== siteOrigin; } catch { return false; }
      };
      const thirdParty = consoleErrors.filter((e) => isThirdParty(e.url));
      const firstParty = consoleErrors.filter((e) => !isThirdParty(e.url));
      if (pageErrors.length === 0 && firstParty.length === 0 && thirdParty.length > 0) {
        return {
          status: responseStatus,
          threw: false,
          info: true,
          error: thirdParty.map((e) => `[third-party] ${e.text}`).join('\n'),
        };
      }
      return {
        status: responseStatus,
        threw: true,
        error: [
          ...pageErrors,
          ...firstParty.map((e) => e.text),
          ...thirdParty.map((e) => `[third-party] ${e.text}`),
        ].join('\n'),
      };
    }
    return { status: responseStatus, threw: false };
  } catch (error) {
    if (/locator|selector|element.*not found/i.test(error?.message || '')) {
      return { status: responseStatus, threw: false, skipped: true, reason: 'selector-not-found' };
    }
    const msg = error?.message || String(error);
    // Phase 0 Fix E2: a page.goto timeout / DNS failure is environmental, not
    // an app bug — flag it for suspected/environmental classification.
    if (/timeout|abort|econnrefused|enotfound|eai_again|getaddrinfo|dns/i.test(msg)) {
      return { status: responseStatus, threw: true, environmental: true, error: msg };
    }
    return { status: responseStatus, threw: true, error: msg };
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── main executor ───────────────────────────────────────────────────

export default async function fuzzExecutor(ctx) {
  const targets = ctx.plan?.fuzzTargets || [];
  const findings = [];

  const activeFuzzAllowed = ctx.options?.allowActiveFuzz === true;
  const delayMs = ctx.options?.delayMs ?? 100; // polite pacing between requests
  const stats = { targetsRun: 0, totalInputs: 0, skippedActiveTargets: 0, skippedInputs: 0, rateLimitedTargets: 0 };
  ctx.onEvent?.(`Fuzzing ${targets.length} targets${activeFuzzAllowed ? ' (authorized active mode)' : ' (safe mode)'}`);

  for (const target of targets) {
    if (ctx.signal?.aborted) break;

    const inputs = generateInputs(target);
    const isApiTarget = Boolean(target.apiEndpointRef);
    if (isApiTarget && !activeFuzzAllowed) {
      stats.skippedActiveTargets++;
      ctx.onEvent?.(`Skipping API fuzz target ${target.apiEndpointRef}.${target.field}: active testing requires authorization`);
      continue;
    }

    stats.targetsRun++;
    stats.totalInputs += inputs.length;
    let failures = 0;
    let rateLimited = false;

    for (let i = 0; i < inputs.length; i++) {
      if (ctx.signal?.aborted) break;

      let result;
      if (isApiTarget) {
        result = await fuzzApiField(target, inputs[i].value, ctx);
      } else {
        result = await fuzzFormField(target, inputs[i].value, ctx);
      }

      if (result.skipped) {
        stats.skippedInputs++;
        continue;
      }

      // Respect 429/503 — the target is telling us to back off. Never hammer:
      // skip the remaining iterations for this target and record it honestly.
      if (result.status === 429 || result.status === 503) {
        rateLimited = true;
        stats.rateLimitedTargets++;
        ctx.onEvent?.(`rate limited — backing off (target ${target.apiEndpointRef || target.fieldSelector} returned ${result.status}; skipping remaining ${inputs.length - i - 1} iteration(s))`);
        break;
      }

      const acceptable = isAcceptableOutcome(result.status, result.threw, target.expectStatus);
      if (result.info) {
        // Phase 0 Fix E2: third-party console noise is kept as an INFO signal —
        // never silently discarded, but not a confirmed bug either.
        const targetRef = `${target.pageUrl} ${target.fieldSelector}`;
        findings.push(ctx.createFinding({
          title: `Fuzz: ${targetRef} (${inputs[i].generator}) — third-party console noise`,
          severity: 'info',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'informational',
          origin: 'third-party',
          ruleId: 'fuzz-third-party-console',
          pageUrl: target.pageUrl || target.apiEndpointRef,
          description: `A third-party script logged a console error while the field was exercised: ${result.error}`,
          evidence: `Generator: ${inputs[i].generator}\nValue: ${inputs[i].value.slice(0, 200)}\nConsole: ${result.error}`,
          suggestedFix: 'Third-party widget noise — verify the widget still works on the affected page; not an app defect by itself.',
        }));
      } else if (!acceptable) {
        failures++;
        // Phase 0 Fix E2: timeout/connection/DNS failures are environmental
        // (suspected, low severity, distinct ruleId) — real 5xx/crash failures
        // keep the original confirmed-bug classification unchanged.
        const environmental = result.environmental === true;
        const targetRef = target.apiEndpointRef
          ? `${target.apiEndpointRef}.${target.field}`
          : `${target.pageUrl} ${target.fieldSelector}`;
        findings.push(ctx.createFinding({
          title: `Fuzz: ${targetRef} (${inputs[i].generator}) caused ${environmental ? 'environmental failure' : result.threw ? 'crash' : `HTTP ${result.status}`}`,
          severity: environmental ? 'low' : (result.threw || (result.status && result.status >= 500) ? 'high' : 'medium'),
          confidence: environmental ? 'suspected' : 'confirmed',
          category: 'network',
          findingType: environmental ? 'environmental' : 'bug',
          origin: 'first-party',
          ruleId: environmental ? 'fuzz-environmental' : 'fuzz-failure',
          pageUrl: target.pageUrl || target.apiEndpointRef,
          description: environmental
            ? (target.apiEndpointRef
              ? `Endpoint ${target.apiEndpointRef} field "${target.field}" could not be exercised (timeout/connection/DNS failure) with generator "${inputs[i].generator}" — environmental, not an app defect.`
              : `Form field "${target.fieldSelector}" on ${target.pageUrl} could not be exercised (timeout/connection/DNS failure) with generator "${inputs[i].generator}" — environmental, not an app defect.`)
            : (target.apiEndpointRef
              ? `Endpoint ${target.apiEndpointRef} field "${target.field}" failed when given value from generator "${inputs[i].generator}".`
              : `Form field "${target.fieldSelector}" on ${target.pageUrl} failed when given value from generator "${inputs[i].generator}".`),
          evidence: `Generator: ${inputs[i].generator}\nValue: ${inputs[i].value.slice(0, 200)}\nStatus: ${result.status ?? 'n/a'}\nError: ${result.error || 'n/a'}`,
          suggestedFix: environmental
            ? 'Re-run when the target environment is healthy; if it persists, check reachability (DNS/firewall) or raise the timeout.'
            : 'Validate + sanitize the field on the server side. Reject malformed input with 400 instead of crashing or returning 5xx.',
        }));
      }

      // Polite pacing between requests (configurable via options.delayMs).
      if (i < inputs.length - 1 && delayMs > 0 && !ctx.signal?.aborted) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    if (rateLimited) {
      ctx.onEvent?.(`Fuzz target ${target.apiEndpointRef || target.fieldSelector}: stopped early (rate limited), ${failures} failure(s) recorded so far`);
    } else {
      ctx.onEvent?.(`Fuzz target ${target.apiEndpointRef || target.fieldSelector}: ${failures}/${inputs.length} failures`);
    }
  }

  ctx.onEvent?.(`fuzz complete: ${findings.length} findings`);
  return {
    findings,
    stats,
  };
}
