import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

/**
 * Unified configuration — merges qagent defaults with SQA-agent extensions.
 *
 * Reads from process.env with sensible defaults for local development.
 * SQA_* prefixed vars take precedence over generic ones when both exist.
 */

/** parseInt with a NaN fallback — PORT=abc must never become NaN. */
function intEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = Object.freeze({
  // Server
  port: intEnv(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Loopback by default — 0.0.0.0 must be an explicit choice (SQA_BIND).
  // SQA_BIND_HOST kept as a legacy alias.
  bindHost: process.env.SQA_BIND || process.env.SQA_BIND_HOST || '127.0.0.1',

  // SSRF — developer-only switch, off by default. Never enable in production or on a public service.
  get allowPrivateTargets() {
    if ((process.env.NODE_ENV || 'development') === 'production') return false;
    return (process.env.SQA_ALLOW_PRIVATE === 'true') ||
      (process.env.ALLOW_PRIVATE_HOSTS === 'true') ||
      (process.env.ALLOW_PRIVATE_TARGETS === 'true');
  },
  get allowPrivateHosts() {
    if ((process.env.NODE_ENV || 'development') === 'production') return false;
    return (process.env.ALLOW_PRIVATE_HOSTS === 'true') ||
      (process.env.SQA_ALLOW_PRIVATE === 'true');
  },

  // CORS
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://localhost:8080').split(','),

  // Rate limiting
  rateLimitMaxRuns: intEnv(process.env.RATE_LIMIT_MAX_RUNS, 5),
  rateLimitWindowMs: intEnv(process.env.RATE_LIMIT_WINDOW_MS, 3600000),

  // Concurrency
  maxConcurrentRuns: intEnv(process.env.MAX_CONCURRENT_RUNS, 2),

  // Browsers — default matrix used when a plan/run doesn't specify one
  defaultBrowsers: (process.env.SQA_DEFAULT_BROWSERS || 'chromium')
    .split(',')
    .map(b => b.trim())
    .filter(Boolean),

  // Chromium sandbox — leave OFF (sandboxed) unless the host cannot run the
  // sandbox (some container setups). The app only opts out when this is set.
  chromiumNoSandbox:
    process.env.SQA_CHROMIUM_NO_SANDBOX === 'true' || process.env.SQA_CHROMIUM_NO_SANDBOX === '1',

  // Page limits
  maxPagesHardLimit: intEnv(process.env.SQA_MAX_PAGES_HARD || process.env.MAX_PAGES_HARD_LIMIT, 100),

  // Timeouts
  get maxRunTimeMs() {
    return intEnv(process.env.SQA_MAX_RUN_MS || process.env.MAX_RUN_TIME_MS, 300000);
  },
  get pageTimeoutMs() {
    return intEnv(process.env.SQA_PAGE_TIMEOUT_MS || process.env.PAGE_TIMEOUT_MS, 30000);
  },
  maxResponseSizeBytes: intEnv(process.env.MAX_RESPONSE_SIZE_BYTES, 10485760),

  // Data retention
  cleanupMaxAgeMs: intEnv(process.env.SQA_CLEANUP_MS || process.env.CLEANUP_MAX_AGE_MS, 86400000),

  // Storage paths
  dataDir: process.env.SQA_DATA_DIR || './data',
  screenshotsDir: process.env.SQA_SCREENSHOTS_DIR || './data/screenshots',

  // Auth — when set, all /api/* routes (except /health) require this token
  apiToken: process.env.SQA_API_TOKEN || '',

  // Scheduler (monitoring) — interval loop that runs due monitors
  schedulerEnabled: process.env.SQA_SCHEDULER_ENABLED !== 'false',
  schedulerIntervalMs: intEnv(process.env.SQA_SCHEDULER_INTERVAL_MS, 60000),

  // Webhook — POST a run summary to this URL after each monitored run
  webhookUrl: process.env.SQA_WEBHOOK_URL || '',

  // Findings & scoring: exclude SUSPECTED-unauthenticated probe findings from scoring by default
  // Set SQA_EXCLUDE_UNAUTHENTICATED=false for aggressive detection
  excludeUnauthenticatedFromScoring:
    process.env.SQA_EXCLUDE_UNAUTHENTICATED !== 'false' &&
    process.env.EXCLUDE_UNAUTHENTICATED !== 'false',

  // Smart page readiness flags (Phase 1)
  settleAnimations: process.env.SQA_SETTLE_ANIMATIONS !== 'false',
  settleIndicators: process.env.SQA_SETTLE_INDICATORS !== 'false',

  // ARIA Snapshot & Privacy flags (Phase 2)
  useAriaSnapshot: process.env.SQA_USE_ARIA_SNAPSHOT !== 'false',
  redactPatterns: process.env.SQA_REDACT_PATTERNS || '',
  maxTextNodeLength: intEnv(process.env.SQA_MAX_TEXT_NODE_LENGTH, 40),
});
