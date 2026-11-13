/**
 * integrations/testResultsPublisher.js — dispatch a completed run's results
 * to an external test-management tool (pain point #10).
 *
 * Exports (consumed by the dashboard via lazy import — names are a contract):
 *   publishRunResults(run, { target, ...opts }) → adapter result
 *   availableTargets()                          → ['testrail','xray'] filtered by env
 *
 * Targets:
 *   'testrail' — needs SQA_TESTRAIL_URL, SQA_TESTRAIL_EMAIL,
 *                SQA_TESTRAIL_API_KEY, SQA_TESTRAIL_PROJECT_ID
 *   'xray'     — needs SQA_XRAY_CLIENT_ID, SQA_XRAY_CLIENT_SECRET
 *
 * Environment presence is validated here first; unset env returns
 * {ok:false, error:'SQA_TESTRAIL_* not configured'} style errors without
 * touching the network. The `opts.adapters` override allows tests (or the
 * dashboard) to inject fake adapter modules via dependency injection.
 */

const TARGETS = {
  testrail: {
    module: () => import('./testRailAdapter.js'),
    requiredEnv: ['SQA_TESTRAIL_URL', 'SQA_TESTRAIL_EMAIL', 'SQA_TESTRAIL_API_KEY', 'SQA_TESTRAIL_PROJECT_ID'],
    label: 'SQA_TESTRAIL_*',
  },
  xray: {
    module: () => import('./xrayAdapter.js'),
    requiredEnv: ['SQA_XRAY_CLIENT_ID', 'SQA_XRAY_CLIENT_SECRET'],
    label: 'SQA_XRAY_*',
  },
};

/**
 * Which targets are usable right now, based on env presence.
 * @returns {string[]} e.g. ['testrail','xray']
 */
export function availableTargets() {
  const targets = [];
  for (const [name, spec] of Object.entries(TARGETS)) {
    if (spec.requiredEnv.every((k) => process.env[k])) targets.push(name);
  }
  return targets;
}

/**
 * Publish a run's results to the requested target.
 *
 * @param {object} run   — a completed run (findings[], runId, score, …)
 * @param {object} [opts] — { target: 'testrail'|'xray', adapters?: {testrail?, xray?},
 *                            …remaining opts are forwarded to the adapter }
 * @returns {Promise<{ok:boolean, error?:string, ...}>}
 */
export async function publishRunResults(run, opts = {}) {
  const { target, adapters = {}, ...adapterOpts } = opts;

  if (!target) {
    return { ok: false, error: `No target given. Available targets: ${availableTargets().join(', ') || 'none'}` };
  }

  const spec = TARGETS[target];
  if (!spec) {
    return { ok: false, error: `Unknown target: ${target}. Available targets: ${availableTargets().join(', ') || 'none'}` };
  }

  // Validate env presence before doing any work.
  const missing = spec.requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    return { ok: false, error: `${spec.label} not configured (missing: ${missing.join(', ')})` };
  }

  // Dependency injection (tests) or lazy-load the adapter module.
  const adapter = adapters[target]
    ? { publishRunResults: adapters[target].publishRunResults ?? adapters[target] }
    : await spec.module();

  try {
    return await adapter.publishRunResults(run, adapterOpts);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
