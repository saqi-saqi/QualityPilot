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
  random: () => Math.random().toString(36).slice(2, 12),
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
    return { status: null, threw: true, error: err.message };
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
        if (message?.type?.() === 'error') consoleErrors.push(message.text?.() || 'Console error');
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
      return {
        status: responseStatus,
        threw: true,
        error: [...pageErrors, ...consoleErrors].join('\n'),
      };
    }
    return { status: responseStatus, threw: false };
  } catch (error) {
    if (/locator|selector|element.*not found/i.test(error?.message || '')) {
      return { status: responseStatus, threw: false, skipped: true, reason: 'selector-not-found' };
    }
    return { status: responseStatus, threw: true, error: error?.message || String(error) };
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
      if (!acceptable) {
        failures++;
        const targetRef = target.apiEndpointRef
          ? `${target.apiEndpointRef}.${target.field}`
          : `${target.pageUrl} ${target.fieldSelector}`;
        findings.push(ctx.createFinding({
          title: `Fuzz: ${targetRef} (${inputs[i].generator}) caused ${result.threw ? 'crash' : `HTTP ${result.status}`}`,
          severity: result.threw || (result.status && result.status >= 500) ? 'high' : 'medium',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: 'fuzz-failure',
          pageUrl: target.pageUrl || target.apiEndpointRef,
          description: target.apiEndpointRef
            ? `Endpoint ${target.apiEndpointRef} field "${target.field}" failed when given value from generator "${inputs[i].generator}".`
            : `Form field "${target.fieldSelector}" on ${target.pageUrl} failed when given value from generator "${inputs[i].generator}".`,
          evidence: `Generator: ${inputs[i].generator}\nValue: ${inputs[i].value.slice(0, 200)}\nStatus: ${result.status ?? 'n/a'}\nError: ${result.error || 'n/a'}`,
          suggestedFix: 'Validate + sanitize the field on the server side. Reject malformed input with 400 instead of crashing or returning 5xx.',
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
