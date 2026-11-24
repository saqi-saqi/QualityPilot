/**
 * integrations/xrayAdapter.js — publish run results to Xray for Jira.
 *
 * Uses the Xray Cloud REST API v2 (default base https://xray.cloud.getxray.app):
 *   POST /api/v2/authenticate   { client_id, client_secret } → JWT token
 *   POST /api/v2/import/execution
 *       Authorization: Bearer <token>
 *       { info: { summary, start, finish },
 *         tests: [{ testKey, status: 'PASS'|'FAILED', comment }] }
 *
 * Required env:
 *   SQA_XRAY_CLIENT_ID     — Xray API client id
 *   SQA_XRAY_CLIENT_SECRET — Xray API client secret
 *
 * Optional env:
 *   SQA_XRAY_BASE_URL      — default https://xray.cloud.getxray.app
 *
 * Test-key mapping — data/xray-map.json, keys are finding signatures
 * (fine `rule::url::element`, legacy `rule::url`, or raw `ruleId::pageUrl`):
 *   { "a11y-contrast::https://example.com/pricing": "QA-101",
 *     "broken-link::https://example.com/::a#signup": "QA-102" }
 * A mapped test FAILS when a finding matching its key exists in the run;
 * a mapped test with no matching finding is reported as PASS. Unmapped
 * findings are listed in the returned summary — tests are never auto-created.
 *
 * Every result is {ok:true, xrayExecutionKey, passed, failed, unmapped} or
 * {ok:false, error} with credentials redacted from any error text.
 */

import { fineSignature, findingSignature } from './issueTracker.js';
import { validateAdapterUrl } from './adapterUrl.js';

const DEFAULT_BASE_URL = 'https://xray.cloud.getxray.app';

const REQUIRED_ENV = ['SQA_XRAY_CLIENT_ID', 'SQA_XRAY_CLIENT_SECRET'];

/**
 * Strip anything that looks like credentials out of an error message.
 */
function redact(text) {
  return String(text || '')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(client[-_]?secret|client[-_]?id|api[-_]?key|password|token)["'=:\s]+\S+/gi, '$1=[REDACTED]');
}

function resolveConfig(opts = {}) {
  const env = process.env;
  const config = {
    baseUrl: (opts.baseUrl || env.SQA_XRAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    clientId: opts.clientId || env.SQA_XRAY_CLIENT_ID,
    clientSecret: opts.clientSecret || env.SQA_XRAY_CLIENT_SECRET,
    mapPath: opts.mapPath || 'data/xray-map.json',
  };
  const missing = REQUIRED_ENV.filter((name) => {
    const v = {
      SQA_XRAY_CLIENT_ID: config.clientId,
      SQA_XRAY_CLIENT_SECRET: config.clientSecret,
    }[name];
    return !v;
  });
  return { config, missing };
}

/**
 * Load the test-key mapping file. Returns {} when the file is absent/invalid —
 * publishing then reports everything as unmapped instead of failing.
 */
async function loadMap(mapPath, inlineMap) {
  if (inlineMap && typeof inlineMap === 'object') return inlineMap;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(mapPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Candidate lookup keys for a finding: fine signature, legacy coarse
 * signature, and raw `ruleId::pageUrl`.
 */
function candidateKeys(finding) {
  const keys = [fineSignature(finding), findingSignature(finding)];
  if (finding.ruleId && finding.pageUrl) keys.push(`${finding.ruleId}::${finding.pageUrl}`);
  return keys;
}

async function api(fetchImpl, url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status >= 400) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Xray API ${res.status}: ${errText.slice(0, 300) || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * Publish a run's findings to Xray (Jira) as a Test Execution.
 *
 * @param {object} run — a completed run (findings[], runId, startedAt, completedAt…)
 * @param {object} [opts] — overrides: baseUrl/clientId/clientSecret/
 *                          mapPath/map/fetch/summary
 * @returns {Promise<{ok:boolean, xrayExecutionKey?:string|null, passed?:number,
 *                    failed?:number, unmapped?:string[], error?:string}>}
 */
export async function publishRunResults(run, opts = {}) {
  const { config, missing } = resolveConfig(opts);
  if (missing.length) {
    return { ok: false, error: `SQA_XRAY_* not configured (missing: ${missing.join(', ')})` };
  }

  // Audit L-3: client credentials are attached to this base URL — validate
  // its shape and scheme before any request is made.
  const urlCheck = validateAdapterUrl(config.baseUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: `Xray base URL rejected: ${urlCheck.error}` };
  }

  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: 'No fetch implementation available' };

  try {
    // 1. Authenticate → JWT token (response is the raw token string)
    const authRes = await api(fetchImpl, `${config.baseUrl}/api/v2/authenticate`, {
      body: { client_id: config.clientId, client_secret: config.clientSecret },
    });
    const authText = (await authRes.text()).trim();
    let token = authText;
    try {
      const parsed = JSON.parse(authText);
      if (typeof parsed === 'string') token = parsed;
    } catch { /* raw token string */ }
    if (!token) throw new Error('Xray authentication returned no token');

    // 2. Map findings → test keys. A mapped test fails if ANY finding matches it.
    const map = await loadMap(config.mapPath, opts.map);
    const mapEntries = Object.entries(map).filter(([, key]) => key);
    const findings = run?.findings || [];

    const failedTests = new Map();    // testKey → comment
    const mappedFindings = new Set(); // findings that matched some map key
    for (const finding of findings) {
      const hit = mapEntries.find(([sig]) => candidateKeys(finding).includes(sig));
      if (!hit) continue;
      const [, testKey] = hit;
      mappedFindings.add(finding);
      if (!failedTests.has(testKey)) {
        failedTests.set(testKey, `${finding.severity || 'info'}: ${finding.title || 'Untitled finding'} — ${finding.pageUrl || ''}`);
      }
    }

    // Unmapped findings are never auto-created as tests — just reported.
    const unmapped = findings
      .filter((f) => !mappedFindings.has(f))
      .map((f) => fineSignature(f));

    // 3. Import execution (mapped-only)
    const tests = [];
    for (const [testKey, comment] of failedTests) {
      tests.push({ testKey, status: 'FAILED', comment });
    }
    for (const [, testKey] of mapEntries) {
      if (!failedTests.has(testKey)) {
        tests.push({ testKey, status: 'PASS', comment: `No finding in run ${run?.runId || 'unknown'}` });
      }
    }

    let xrayExecutionKey = null;
    if (tests.length > 0) {
      const executionBody = {
        info: {
          summary: opts.summary || `QualityPilot — run ${run?.runId || new Date().toISOString()}`,
        },
        tests,
      };
      if (run?.startedAt) executionBody.info.start = run.startedAt;
      if (run?.completedAt) executionBody.info.finish = run.completedAt;

      const importRes = await api(fetchImpl, `${config.baseUrl}/api/v2/import/execution`, {
        headers: { 'Authorization': `Bearer ${token}` },
        body: executionBody,
      });
      // Parse defensively — import/execution returns { issues: [{ key, ... }] }
      try {
        const data = JSON.parse(await importRes.text());
        xrayExecutionKey = data?.issues?.[0]?.key ?? null;
      } catch { /* leave null */ }
    }

    return {
      ok: true,
      xrayExecutionKey,
      passed: tests.filter((t) => t.status === 'PASS').length,
      failed: tests.filter((t) => t.status === 'FAILED').length,
      unmapped,
    };
  } catch (err) {
    return { ok: false, error: redact(err?.message || String(err)) };
  }
}
