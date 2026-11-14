/**
 * executors/apiContract.js — probe API endpoints + verify contracts.
 *
 * Consumes: plan.apiEndpoints[]
 * Produces: findings per endpoint (status mismatch, schema mismatch, network error)
 *
 * No Playwright needed — uses global fetch. Fully testable by injecting
 * a fake fetch via ctx.options.fetch.
 *
 * Executor context contract:
 *   ctx.plan.apiEndpoints[]    — endpoints to probe
 *   ctx.options.fetch          — optional fetch impl (default: global fetch)
 *   ctx.options.timeout        — per-request timeout ms (default: 15000)
 *   ctx.createFinding          — finding factory
 *   ctx.onEvent                — SSE progress
 *   ctx.signal                  — AbortSignal
 */

import { safeFetch } from '../services/ssrf.js';
import { config } from '../utils/config.js';

const DEFAULT_TIMEOUT_MS = 15000;

/** Build a fetch with timeout via AbortController */
function withTimeout(fetchImpl, ms, externalSignal) {
  return (url, opts = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Request timeout')), ms);
    // Honor external abort too
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    return fetchImpl(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };
}

/**
 * Substitute :id / :slug path params with concrete values from endpoint.pathParams.
 * Returns the substituted path (still relative — caller prepends baseUrl).
 */
export function substitutePathParams(path, pathParams = {}) {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (pathParams[name] != null) return encodeURIComponent(pathParams[name]);
    return '0';  // safe default
  });
}

/** Build the full URL: baseUrl (or plan.targetUrl origin) + path + query. */
function buildUrl(endpoint, fallbackOrigin) {
  const origin = endpoint.baseUrl || fallbackOrigin;
  const substituted = substitutePathParams(endpoint.path, endpoint.pathParams);
  const url = new URL(substituted, origin);
  for (const [k, v] of Object.entries(endpoint.queryParams || {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Verify a response body against a (very minimal) JSON schema.
 * The schema is the one inferred by apiInferrer — top-level shape only.
 * Supports:
 *   { type: 'object', properties: {...}, required?: [...] } — keys listed in
 *     `required` must exist; other properties are type-checked only when
 *     present (apiInferrer marks a key required only if it appeared in ≥2
 *     observed responses, softening false mismatches from one-off fields)
 *   { type: 'array', items?: {...} }          — checks Array.isArray; item
 *     shapes are validated ONLY when the plan declares schema.items
 *   { type: 'object', properties: {...} } without `required` — checks each
 *     prop exists (legacy behavior)
 *   { type: 'string' | 'number' | 'boolean' } — checks typeof
 *   plain object { field: 'string' }         — legacy format, checks each key
 *   plain array [...]                         — checks body is array
 *
 * Returns { ok: true } | { ok: false, mismatches: string[] }
 */
export function verifySchema(body, schema) {
  if (schema == null) return { ok: true };
  const mismatches = [];

  // Handle null body when schema is non-null
  if (body == null) {
    return { ok: false, mismatches: ['response body is null/undefined but schema is present'] };
  }

  // Standard JSON schema-ish
  if (schema.type) {
    if (schema.type === 'object') {
      if (typeof body !== 'object' || Array.isArray(body) || body === null) {
        return { ok: false, mismatches: [`expected object, got ${Array.isArray(body) ? 'array' : typeof body}`] };
      }
      if (schema.properties) {
        const requiredList = Array.isArray(schema.required)
          ? schema.required
          : Object.keys(schema.properties); // no `required` annotation → legacy: all required
        for (const [field, fieldSchema] of Object.entries(schema.properties)) {
          if (!(field in body)) {
            if (requiredList.includes(field)) {
              mismatches.push(`missing required field: ${field}`);
            }
            continue;
          }
          // Recurse — shallow
          const sub = verifySchema(body[field], fieldSchema);
          if (!sub.ok) mismatches.push(`field ${field}: ${sub.mismatches.join('; ')}`);
        }
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(body)) {
        return { ok: false, mismatches: [`expected array, got ${typeof body}`] };
      }
      // Validate item shapes ONLY when the plan declares them
      if (schema.items && Array.isArray(body)) {
        for (let i = 0; i < Math.min(body.length, 20); i++) {
          const sub = verifySchema(body[i], schema.items);
          if (!sub.ok) mismatches.push(`item ${i}: ${sub.mismatches.join('; ')}`);
        }
      }
    } else if (schema.type === 'string') {
      if (typeof body !== 'string') mismatches.push(`expected string, got ${typeof body}`);
    } else if (schema.type === 'number') {
      if (typeof body !== 'number') mismatches.push(`expected number, got ${typeof body}`);
    } else if (schema.type === 'boolean') {
      if (typeof body !== 'boolean') mismatches.push(`expected boolean, got ${typeof body}`);
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  // Legacy: plain object { field: 'string' }  → check each field exists
  if (typeof schema === 'object' && !Array.isArray(schema)) {
    if (typeof body !== 'object' || Array.isArray(body) || body === null) {
      return { ok: false, mismatches: [`expected object, got ${typeof body}`] };
    }
    for (const field of Object.keys(schema)) {
      if (!(field in body)) mismatches.push(`missing required field: ${field}`);
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  // Legacy: plain array
  if (Array.isArray(schema)) {
    if (!Array.isArray(body)) {
      return { ok: false, mismatches: [`expected array, got ${typeof body}`] };
    }
    return { ok: true };
  }

  return { ok: true };
}

/**
 * Probe a single endpoint.
 * Returns { endpoint, status?, durationMs, body?, findings: [] } — plus a
 * `finding` alias for the first finding (back-compat).
 */
export async function probeEndpoint(endpoint, ctx) {
  const allowPrivate = ctx.options?.allowPrivateTargets || config.allowPrivateTargets;
  const fetchImpl = ctx.options?.fetch || (allowPrivate ? globalThis.fetch : safeFetch);
  if (!fetchImpl) {
    throw new Error('No fetch implementation available. Pass ctx.options.fetch or safeFetch.');
  }
  const timeoutMs = ctx.options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const fetchWithTimeout = withTimeout(fetchImpl, timeoutMs, ctx.signal);

  const fallbackOrigin = (() => {
    try { return new URL(ctx.plan.targetUrl).origin; } catch { return ctx.plan.targetUrl; }
  })();

  const url = buildUrl(endpoint, fallbackOrigin);

  // Same-origin enforcement — a plan (or a compromised inference) pointing
  // probes at third-party origins is refused, not fetched.
  try {
    const urlOrigin = new URL(url).origin;
    const targetOrigin = new URL(fallbackOrigin).origin;
    if (urlOrigin !== targetOrigin) {
      ctx.onEvent?.(`Refused cross-origin API probe: ${url} (target origin ${targetOrigin})`);
      const finding = ctx.createFinding({
        title: `API ${endpoint.method} ${endpoint.path} is cross-origin with the run target`,
        severity: 'high',
        confidence: 'confirmed',
        category: 'security',
        findingType: 'warning',
        origin: 'first-party',
        ruleId: 'api-cross-origin-blocked',
        pageUrl: url,
        description: `The composed endpoint URL (${urlOrigin}) is not same-origin with the run target (${targetOrigin}). The probe was skipped — contract tests must target the site under test.`,
        evidence: `Endpoint: ${endpoint.method} ${endpoint.path}\nComposed URL: ${url}\nTarget origin: ${targetOrigin}`,
        suggestedFix: 'Remove the endpoint\'s baseUrl override (or point it at the run target) so probes only hit the site under test.',
      });
      return { endpoint, status: null, durationMs: 0, body: null, findings: [finding], finding, skipped: true, skipReason: 'cross-origin' };
    }
  } catch { /* unparseable URL — fetch will fail below with a clearer error */ }

  const start = Date.now();

  const headers = { ...endpoint.headers };
  // Recorded-session cookie (monitor runs) — lets contract probes test the
  // authenticated API instead of the anonymous one.
  if (ctx.options?.sessionCookie && !headers['Cookie']) {
    headers['Cookie'] = ctx.options.sessionCookie;
  }
  // Auth — secretRef is resolved from env. A missing secret means we probe
  // UNAUTHENTICATED (and say so): a bogus placeholder credential would
  // produce misleading findings. Only SQA_TD_* prefixed secrets are permitted.
  const APPROVED_SECRET_REF = /^SQA_TD_[A-Z0-9_]+$/;
  if (endpoint.auth?.type === 'bearer' && endpoint.auth.secretRef) {
    if (!APPROVED_SECRET_REF.test(endpoint.auth.secretRef)) {
      throw new Error(`Unapproved secretRef: "${endpoint.auth.secretRef}" — only SQA_TD_* prefixed secrets are allowed`);
    }
    const secret = process.env[endpoint.auth.secretRef];
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    } else {
      ctx.onEvent?.(`secret ${endpoint.auth.secretRef} not set — probing unauthenticated`);
    }
  } else if (endpoint.auth?.type === 'basic' && endpoint.auth.secretRef) {
    if (!APPROVED_SECRET_REF.test(endpoint.auth.secretRef)) {
      throw new Error(`Unapproved secretRef: "${endpoint.auth.secretRef}" — only SQA_TD_* prefixed secrets are allowed`);
    }
    const secret = process.env[endpoint.auth.secretRef];
    if (secret) {
      // The env value is expected to be the pre-encoded "user:pass" credential
      headers['Authorization'] = `Basic ${secret}`;
    } else {
      ctx.onEvent?.(`secret ${endpoint.auth.secretRef} not set — probing unauthenticated`);
    }
  }

  const init = {
    method: endpoint.method,
    headers,
  };
  if (endpoint.body != null && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    init.body = typeof endpoint.body === 'string' ? endpoint.body : JSON.stringify(endpoint.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetchWithTimeout(url, init);
    const durationMs = Date.now() - start;
    const status = response.status;

    let body = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try { body = await response.json(); } catch { body = null; }
    } else {
      try { body = await response.text(); } catch { body = null; }
    }

    // Status check
    if (endpoint.expectedStatus != null && endpoint.expectedStatus !== status) {
      // Downgrade when the "mismatch" reproduces reality or bot protection
      // rather than breaking it:
      //   • sessionGated     — captured WITH credentials, replayed anonymously
      //   • nonGetReplay     — no cookies/CSRF are sent on replays
      //   • matchesObservation — the real browser also received this status
      //   • wafBlocked       — a WAF/Cloudflare challenge page blocked the probe
      const sessionGated = endpoint.requiresSession === true;
      const nonGetReplay = endpoint.method !== 'GET';
      const matchesObservation = Array.isArray(endpoint.observedStatuses)
        && endpoint.observedStatuses.includes(status);
      const wafBlocked = (status === 403 || status === 503)
        && typeof body === 'string'
        && /cloudflare|attention required|cf-ray|challenge-platform/i.test(body);
      const anonymousReplay = sessionGated || nonGetReplay;
      const expectationWrong = matchesObservation && !anonymousReplay && !wafBlocked;
      const downgraded = anonymousReplay || expectationWrong || wafBlocked;
      const reason = wafBlocked ? 'waf' : expectationWrong ? 'observation' : 'anonymous';
      return {
        endpoint, status, durationMs, body,
        finding: ctx.createFinding({
          title: `API ${endpoint.method} ${endpoint.path} returned unexpected status`,
          severity: downgraded ? 'low' : (status >= 500 ? 'high' : 'medium'),
          confidence: downgraded ? 'suspected' : 'confirmed',
          category: 'network',
          findingType: downgraded ? 'environmental' : 'bug',
          origin: 'first-party',
          ruleId: 'api-status-mismatch',
          pageUrl: url,
          unauthenticated: anonymousReplay,
          description: reason === 'waf'
            ? `Expected status ${endpoint.expectedStatus} but got ${status} with a WAF/bot-protection challenge page. The site's firewall blocked the anonymous probe — this is protection working, not a site bug.`
            : reason === 'observation'
              ? `Expected status ${endpoint.expectedStatus} but got ${status}. The site's own browser traffic also received ${status} for this endpoint during the crawl — the recorded expectation may be wrong rather than the site.`
              : anonymousReplay
                ? `Expected status ${endpoint.expectedStatus} but got ${status}. The probe replayed a captured ${endpoint.method} request anonymously${sessionGated ? ' (the original request carried session credentials)' : ''} — the endpoint may simply require a session or CSRF token.`
                : `Expected status ${endpoint.expectedStatus} but got ${status}.`,
          evidence: `Endpoint: ${endpoint.method} ${endpoint.path}\nURL: ${url}\nStatus: ${status}\nResponse: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`,
          suggestedFix: downgraded
            ? reason === 'waf'
              ? 'No action needed — this is the site\'s bot protection. If the endpoint must be probed, allow-list the scanner or use a browser-context probe.'
              : 'Verify manually with a logged-in session, or update the endpoint contract to match what the site really returns.'
            : endpoint.expectedStatus >= 200 && endpoint.expectedStatus < 300
              ? 'Investigate why a normally-successful endpoint is returning non-success.'
              : 'Update the endpoint contract if the new status is expected.',
        }),
      };
    }

    // Schema check
    if (endpoint.responseSchema) {
      const result = verifySchema(body, endpoint.responseSchema);
      if (!result.ok) {
        // An empty response body usually means the replay was bot-walled or
        // session-gated (e.g. 200 with an empty challenge body) — not a real
        // schema break. Session-gated endpoints get the same treatment.
        const gated = endpoint.requiresSession === true || body == null || body === '';
        return {
          endpoint, status, durationMs, body,
          finding: ctx.createFinding({
            title: `API ${endpoint.method} ${endpoint.path} response schema mismatch`,
            severity: gated ? 'low' : 'medium',
            confidence: gated ? 'suspected' : 'high',
            category: 'network',
            findingType: gated ? 'environmental' : 'bug',
            origin: 'first-party',
            ruleId: 'api-schema-mismatch',
            pageUrl: url,
            unauthenticated: gated,
            description: gated
              ? `Response body does not match the expected schema: ${result.mismatches.join('; ')}. The replay got an empty/blocked response — it may be bot-walled or session-gated; verify manually.`
              : `Response body does not match the expected schema: ${result.mismatches.join('; ')}`,
            evidence: `Expected: ${JSON.stringify(endpoint.responseSchema)}\nActual: ${JSON.stringify(body).slice(0, 500)}`,
            suggestedFix: gated
              ? 'Re-check with a real session or browser context; if the shape still differs, update the contract.'
              : 'Either fix the API to return the documented shape or update the contract.',
          }),
        };
      }
    }

    // Latency budget — measured latency over the endpoint's declared budget
    // is a low-severity, honest signal (not a hard failure).
    if (endpoint.latencyBudgetMs != null && durationMs > endpoint.latencyBudgetMs) {
      return {
        endpoint, status, durationMs, body,
        finding: ctx.createFinding({
          title: `API ${endpoint.method} ${endpoint.path} exceeded its latency budget`,
          severity: 'low',
          confidence: 'confirmed',
          category: 'performance',
          findingType: 'warning',
          origin: 'first-party',
          ruleId: 'api-latency-budget',
          pageUrl: url,
          description: `Measured latency ${durationMs}ms exceeded the declared budget of ${endpoint.latencyBudgetMs}ms.`,
          evidence: `Endpoint: ${endpoint.method} ${endpoint.path}\nURL: ${url}\nMeasured: ${durationMs}ms\nBudget: ${endpoint.latencyBudgetMs}ms\nOver by: ${durationMs - endpoint.latencyBudgetMs}ms`,
          suggestedFix: 'Investigate server-side latency for this endpoint (caching, DB queries, cold starts) or raise the budget if the target is realistic.',
        }),
      };
    }

    return { endpoint, status, durationMs, body };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err?.message || String(err);
    const isTimeout = /timeout|abort/i.test(msg);
    // Phase 0 Fix E1: network-unreachable failures (refused / not-found / DNS)
    // are environment problems, not app defects — same treatment as timeouts:
    // suspected + environmental + low severity, never a confirmed bug.
    const isUnreachable = /econnrefused|enotfound|eai_again|getaddrinfo|dns/i.test(msg);
    const environmental = isTimeout || isUnreachable;
    return {
      endpoint, status: null, durationMs,
      finding: ctx.createFinding({
        title: `API ${endpoint.method} ${endpoint.path} ${isTimeout ? 'timed out' : 'failed'}`,
        severity: environmental ? 'low' : 'high',
        confidence: environmental ? 'suspected' : 'confirmed',
        category: 'network',
        findingType: environmental ? 'environmental' : 'bug',
        origin: 'first-party',
        ruleId: isTimeout ? 'api-timeout' : 'api-error',
        pageUrl: url,
        description: msg,
        evidence: `URL: ${url}\nMethod: ${endpoint.method}\nDuration: ${durationMs}ms`,
        suggestedFix: isTimeout
          ? 'Increase the per-request timeout or investigate endpoint latency.'
          : 'Verify the endpoint is reachable from this environment.',
      }),
    };
  }
}

/** Main executor entry — registered as 'api-contract' in the registry. */
export default async function apiContractExecutor(ctx) {
  const endpoints = ctx.plan?.apiEndpoints || [];
  const findings = [];

  ctx.onEvent?.(`Probing ${endpoints.length} API endpoints`);

  for (const endpoint of endpoints) {
    if (ctx.signal?.aborted) break;
    const { finding } = await probeEndpoint(endpoint, ctx);
    if (finding) findings.push(finding);
  }

  ctx.onEvent?.(`api-contract complete: ${findings.length} findings`);
  return { findings, stats: { probed: endpoints.length, failed: findings.length } };
}
