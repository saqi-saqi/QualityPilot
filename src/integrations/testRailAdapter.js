/**
 * integrations/testRailAdapter.js — publish run results to TestRail (pain point #10).
 *
 * TestRail API v2 uses HTTP Basic auth (`email:apikey` base64) and lives under
 *   POST {url}/index.php?/api/v2/add_run/{project_id}
 *   POST {url}/index.php?/api/v2/add_results_for_cases/{run_id}
 *   body: { results: [{ case_id, status_id, comment }] }   (1 = passed, 5 = failed)
 *
 * Required env:
 *   SQA_TESTRAIL_URL        — e.g. https://foo.testrail.io
 *   SQA_TESTRAIL_EMAIL      — TestRail user email
 *   SQA_TESTRAIL_API_KEY    — TestRail API key (My Settings → API Access)
 *   SQA_TESTRAIL_PROJECT_ID — numeric project id
 *
 * Optional env:
 *   SQA_TESTRAIL_SUITE_ID   — suite id (for multi-suite projects)
 *   SQA_TESTRAIL_RUN_NAME   — name for the created test run
 *
 * Case mapping — data/testrail-map.json, keys are either a finding signature
 * or `ruleId::pageUrl`:
 *   { "a11y-contrast::https://example.com/pricing": 1234,
 *     "broken-link::https://example.com/::a#signup": 1235 }
 * A mapped case FAILS when a finding matching its key exists in the run;
 * a mapped case with no matching finding is reported as PASSED. Unmapped
 * findings are listed in the returned summary — cases are never auto-created.
 *
 * Every result is {ok:true, testRailRunId, passed, failed, unmapped} or
 * {ok:false, error} with credentials redacted from any error text.
 */

import { fineSignature, findingSignature } from './issueTracker.js';
import { validateAdapterUrl } from './adapterUrl.js';

const STATUS_PASSED = 1;
const STATUS_FAILED = 5;

const REQUIRED_ENV = ['SQA_TESTRAIL_URL', 'SQA_TESTRAIL_EMAIL', 'SQA_TESTRAIL_API_KEY', 'SQA_TESTRAIL_PROJECT_ID'];

/**
 * Strip anything that looks like credentials out of an error message.
 */
function redact(text) {
  return String(text || '')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_]?key|password|token)["'=:\s]+\S+/gi, '$1=[REDACTED]');
}

/**
 * Resolve config from explicit options first, then env.
 * Returns { config, missing } — missing lists the required env names not set.
 */
function resolveConfig(opts = {}) {
  const env = process.env;
  const config = {
    url: (opts.url || env.SQA_TESTRAIL_URL || '').replace(/\/$/, ''),
    email: opts.email || env.SQA_TESTRAIL_EMAIL,
    apiKey: opts.apiKey || env.SQA_TESTRAIL_API_KEY,
    projectId: opts.projectId || env.SQA_TESTRAIL_PROJECT_ID,
    suiteId: opts.suiteId || env.SQA_TESTRAIL_SUITE_ID || null,
    runName: opts.runName || env.SQA_TESTRAIL_RUN_NAME || null,
    mapPath: opts.mapPath || 'data/testrail-map.json',
  };
  const missing = REQUIRED_ENV.filter((name) => {
    const v = {
      SQA_TESTRAIL_URL: config.url,
      SQA_TESTRAIL_EMAIL: config.email,
      SQA_TESTRAIL_API_KEY: config.apiKey,
      SQA_TESTRAIL_PROJECT_ID: config.projectId,
    }[name];
    return !v;
  });
  return { config, missing };
}

/**
 * Load the case mapping file. Returns {} when the file is absent/invalid —
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

/**
 * Publish a run's findings to TestRail.
 *
 * @param {object} run — a completed run (findings[], runId, score, url…)
 * @param {object} [opts] — overrides: url/email/apiKey/projectId/suiteId/
 *                          runName/mapPath/map/fetch
 * @returns {Promise<{ok:boolean, testRailRunId?:number|null, passed?:number,
 *                    failed?:number, unmapped?:string[], error?:string}>}
 */
export async function publishRunResults(run, opts = {}) {
  const { config, missing } = resolveConfig(opts);
  if (missing.length) {
    return { ok: false, error: `SQA_TESTRAIL_* not configured (missing: ${missing.join(', ')})` };
  }

  // Audit L-3: this URL carries Basic-auth credentials — validate its shape
  // and scheme (https unless SQA_ALLOW_INSECURE_ADAPTER_HTTP=1) before use.
  const urlCheck = validateAdapterUrl(config.url);
  if (!urlCheck.ok) {
    return { ok: false, error: `TestRail URL rejected: ${urlCheck.error}` };
  }

  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: 'No fetch implementation available' };

  const authHeader = 'Basic ' + Buffer.from(`${config.email}:${config.apiKey}`).toString('base64');
  const findings = run?.findings || [];

  try {
    const map = await loadMap(config.mapPath, opts.map);
    const mapEntries = Object.entries(map)
      .filter(([, caseId]) => caseId != null && caseId !== '')
      .map(([key, caseId]) => [key, Number(caseId)]);

    // Map findings → case ids. A case fails if ANY finding matches it.
    const failedCases = new Map();   // caseId → comment
    const mappedFindings = new Set(); // findings that matched some map key
    for (const finding of findings) {
      const hit = mapEntries.find(([key]) => candidateKeys(finding).includes(key));
      if (!hit) continue;
      const [, caseId] = hit;
      mappedFindings.add(finding);
      if (!failedCases.has(caseId)) {
        failedCases.set(caseId, `${finding.severity || 'info'}: ${finding.title || 'Untitled finding'} — ${finding.pageUrl || ''}`);
      }
    }

    // Unmapped findings are never auto-created as cases — just reported.
    const unmapped = findings
      .filter((f) => !mappedFindings.has(f))
      .map((f) => fineSignature(f));

    const results = [];
    // Mapped cases with a matching finding → failed
    for (const [caseId, comment] of failedCases) {
      results.push({ case_id: caseId, status_id: STATUS_FAILED, comment });
    }
    // Remaining mapped cases (no finding this run) → passed
    for (const [, caseId] of mapEntries) {
      if (!failedCases.has(caseId)) {
        results.push({ case_id: caseId, status_id: STATUS_PASSED, comment: `No finding in run ${run?.runId || 'unknown'}` });
      }
    }

    const caseIds = [...new Set(mapEntries.map(([, id]) => id))];
    let testRailRunId = null;

    if (caseIds.length > 0) {
      // Find-or-create run: include_all:false, only our mapped case ids.
      const runBody = {
        name: config.runName || `QualityPilot — run ${run?.runId || new Date().toISOString()}`,
        include_all: false,
        case_ids: caseIds,
      };
      if (config.suiteId) runBody.suite_id = Number(config.suiteId);

      const created = await api(fetchImpl, config, authHeader,
        'POST', `/index.php?/api/v2/add_run/${config.projectId}`, runBody);
      testRailRunId = created?.id ?? null;

      if (results.length > 0) {
        await api(fetchImpl, config, authHeader,
          'POST', `/index.php?/api/v2/add_results_for_cases/${testRailRunId}`, { results });
      }
    }

    return {
      ok: true,
      testRailRunId,
      passed: results.filter((r) => r.status_id === STATUS_PASSED).length,
      failed: results.filter((r) => r.status_id === STATUS_FAILED).length,
      unmapped,
    };
  } catch (err) {
    return { ok: false, error: redact(err?.message || String(err)) };
  }
}

async function api(fetchImpl, config, authHeader, method, path, body) {
  const url = `${config.url}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status >= 400) {
    const errBody = (await parseBody(res)) || {};
    const err = new Error(`TestRail API ${res.status}: ${errBody.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  // TestRail returns a JSON document (possibly empty array for no results)
  return parseBody(res);
}

async function parseBody(res) {
  try {
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    if (typeof res.json === 'function') return await res.json();
    return null;
  } catch {
    return null;
  }
}
