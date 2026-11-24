/**
 * executors/authz.js — anonymous-reachability probe for admin-namespaced APIs.
 *
 * Captured GET endpoints whose path is admin-namespaced (`/admin`…/`) should
 * never answer 2xx without credentials. The probe re-requests them
 * anonymously — the same traffic profile the crawler already produced — and
 * flags reachable ones. Evidence is status + size only: admin response bodies
 * can contain sensitive configuration and are deliberately not recorded.
 *
 * Phase F-era recon on Juice Shop: `/rest/admin/application-configuration`
 * and `/rest/admin/application-version` both answer 200 anonymously (36KB of
 * config) — a real finding the crawl itself cannot see.
 *
 * No browser, no mutations, no authorization gate: this is read-only traffic
 * the crawl already generated.
 *
 * Transport (audit L-3): probe requests go through ssrf.safeFetch — every
 * redirect hop is SSRF-re-validated BEFORE the scanner connects; a blocked
 * hop fails the probe closed and is logged.
 */

import { safeFetch } from '../services/ssrf.js';
import { config } from '../utils/config.js';

const ADMIN_PATH_RE = /\/admin(?:istrator|istration)?(?=\/|$|\.)/i;
const MAX_ENDPOINTS = 10;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

export default async function authzExecutor(ctx) {
  const findings = [];
  const stats = { adminEndpointsProbed: 0, reachableAnonymously: 0 };

  const targetUrl = ctx.plan?.targetUrl;
  if (!targetUrl) return { findings, stats };

  const endpoints = (ctx.plan?.apiEndpoints || []).filter(
    (e) => e.method === 'GET' && ADMIN_PATH_RE.test(String(e.path || '')),
  );
  if (endpoints.length === 0) {
    ctx.onEvent?.('authz complete: no admin-namespaced endpoints captured');
    return { findings, stats };
  }
  if (endpoints.length > MAX_ENDPOINTS) {
    // Audit L-7: the cap is a latency guard, but truncation must be visible.
    ctx.onEvent?.(`authz: probing the first ${MAX_ENDPOINTS} of ${endpoints.length} admin endpoints (cap)`);
  }

  // Transport (audit L-3): strict mode → safeFetch (every redirect hop
  // SSRF-re-validated); dev mode (per-run allowPrivateTargets option or env
  // opt-in) keeps the plain fetch transport so loopback fixtures are reachable.
  const fetchImpl = ctx.options?.fetch
    || ((ctx.options?.allowPrivateTargets || config.allowPrivateTargets) ? globalThis.fetch : safeFetch);
  const timeoutMs = ctx.options?.timeout ?? 10000;

  for (const endpoint of endpoints.slice(0, MAX_ENDPOINTS)) {
    if (ctx.signal?.aborted) break;
    const base = originOf(endpoint.baseUrl || targetUrl);
    // Audit L-7: one endpoint with an unusable baseUrl used to break the
    // whole loop (every later admin endpoint went unprobed). Skip it instead.
    if (!base || !fetchImpl) {
      stats.skippedNoBase = (stats.skippedNoBase || 0) + 1;
      ctx.onEvent?.(`authz: skipped ${endpoint.path} — no usable origin`);
      continue;
    }

    const qs = Object.keys(endpoint.queryParams || {}).length
      ? '?' + new URLSearchParams(endpoint.queryParams).toString()
      : '';
    const url = `${base}${endpoint.path}${qs}`;

    stats.adminEndpointsProbed++;
    let status = null;
    let length = 0;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (ctx.signal) ctx.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      const res = await fetchImpl(url, {
        method: 'GET',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      status = res.status;
      const body = await res.text();
      length = body.length;
    } catch (err) {
      // Includes SSRF-blocked redirect hops (safeFetch): fail closed, but say
      // why — silent swallowing hid a detector bug once (Phase 8 lesson).
      ctx.onEvent?.(`authz probe blocked/failed for ${url}: ${err?.message || err}`);
      continue; // unreachable or blocked — the crawler already reports reachability
    }

    if (status >= 200 && status < 300) {
      stats.reachableAnonymously++;
      findings.push(ctx.createFinding({
        title: `Admin-namespaced API reachable without authentication: ${endpoint.path}`,
        severity: 'medium',
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        origin: 'first-party',
        ruleId: 'authz-missing',
        pageUrl: url,
        description: `GET ${endpoint.path} answered ${status} with a ${length}-byte body when requested anonymously. Admin-namespaced APIs should require an authenticated, privileged session. The response body was deliberately not recorded (admin payloads may contain secrets).`,
        evidence: `Anonymous GET → HTTP ${status}, ${length} bytes`,
        suggestedFix: 'Require an authenticated session with an admin role on every /admin-namespaced route (middleware/guard), not just in the UI.',
      }));
    }
  }

  ctx.onEvent?.(`authz complete: ${findings.length} findings (${stats.reachableAnonymously}/${stats.adminEndpointsProbed} admin endpoints reachable anonymously)`);
  return { findings, stats };
}
