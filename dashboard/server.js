/**
 * dashboard/server.js — lightweight HTTP dashboard for QualityPilot.
 *
 * Reads run JSON files from the runManager's data dir and serves:
 *   • Static HTML/CSS/JS at /            → dashboard UI
 *   • GET  /api/runs                     → list of runs (metadata only)
 *   • POST /api/runs                     → start a run ({url,…} or {planDraftId})
 *   • GET  /api/runs/:runId              → full run details + findings (+ triage states)
 *   • PATCH /api/runs/:runId/findings    → set triage state on a finding
 *   • GET  /api/runs/:runId/diff         → run-to-run comparison (?against= other run,
 *                                          auto-picks the most recent earlier run)
 *   • GET  /api/runs/:runId/evidence     → WCAG evidence export (JSON attachment)
 *   • POST /api/runs/:runId/publish      → publish results to TestRail / Xray
 *   • POST /api/plan                     → draft a reviewable test plan (human-in-the-loop)
 *   • GET  /api/runs/:runId/events       → SSE stream of run events
 *   • GET  /api/runs/:runId/report.json  → machine-readable report
 *   • GET  /api/runs/:runId/report.html  → human-readable HTML report
 *   • GET  /api/trends                    → aggregate stats across recent runs
 *   • GET  /api/runs/:runId/screenshots/:file  → screenshot PNG (run-scoped)
 *   • Monitor routes — list/create/edit(PUT)/delete, run-now, record-login
 *     (?role=), per-role session list + delete, record-status/cancel
 *
 * Security:
 *   • helmet headers (CSP tuned for the dashboard's local assets + Google Fonts)
 *   • CORS echoes the request Origin only when it is in config.allowedOrigins
 *   • small in-memory fixed-window rate limiter on /api/* (skipped in tests)
 *   • timing-safe API token comparison (sha256-length-normalized)
 *   • screenshots only served when the filename belongs to the requested run
 *   • /api/record-status strips query strings (page URLs can hold reset tokens)
 *   • binds to config.bindHost (127.0.0.1 by default — never 0.0.0.0 silently)
 *   • refuses to start with NODE_ENV=production and no SQA_API_TOKEN
 *   • SIGTERM/SIGINT → scheduler.stop() + runManager.shutdown() + exit 0
 *
 * Note: runManager + report modules are lazy-imported inside handlers so
 * the dashboard test suite can import computeTrends() without requiring
 * the user's checks/* modules (which runManager.js imports at top-level).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import helmet from 'helmet';
import { config } from '../src/utils/config.js';

// Single source of truth for the tool version (package.json) — hardcoded
// literals went stale at every release.
const { version: PKG_VERSION } = createRequire(import.meta.url)('../package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Honor config.dataDir (env SQA_DATA_DIR) so sessions/flaky/SQlite live in one
// place; fall back to ./data relative to the cwd.
const DATA_DIR = path.resolve(config.dataDir || path.join(process.cwd(), 'data'));
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

const DEFAULT_PORT = Number(process.env.SQA_DASHBOARD_PORT) || 8080;

// ─── security middleware (helmet) ────────────────────────────────────
// The dashboard loads only local assets + Google Fonts, so a CSP that
// allows exactly those is safe here. If a future view needs more, loosen
// deliberately — or fall back to helmet({ contentSecurityPolicy: false }).
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // The dashboard is commonly served over plain HTTP locally — don't
      // force-upgrade its own subresources to https (null = drop the directive).
      upgradeInsecureRequests: null,
    },
  },
});

// ─── rate limiting (tiny in-memory fixed-window limiter) ─────────────
// express-rate-limit targets Express; this server is raw http, so a ~40-line
// equivalent lives here. Fixed window per IP. POST /api/runs uses the tighter
// config.rateLimitMaxRuns budget; every other /api route shares a generous one.
const RATE_LIMIT_STORE = new Map();          // key → { count, windowStart }
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_LIMIT_GENERAL_MAX = Number(process.env.RATE_LIMIT_GENERAL_MAX) || 600;

/**
 * Fixed-window rate limit check for `key`. Pure + exported for tests.
 * @returns {{ ok: boolean, count: number, remaining: number, retryAfterMs: number }}
 */
export function checkRateLimit(key, { max = RATE_LIMIT_GENERAL_MAX, windowMs = RATE_LIMIT_WINDOW_MS, now = Date.now() } = {}) {
  // Opportunistic cleanup so abandoned IPs don't grow the map forever.
  if (RATE_LIMIT_STORE.size > 5000) {
    for (const [k, v] of RATE_LIMIT_STORE) {
      if (now - v.windowStart >= windowMs) RATE_LIMIT_STORE.delete(k);
    }
  }
  const entry = RATE_LIMIT_STORE.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    RATE_LIMIT_STORE.set(key, { count: 1, windowStart: now });
    return { ok: true, count: 1, remaining: Math.max(0, max - 1), retryAfterMs: 0 };
  }
  entry.count += 1;
  if (entry.count > max) {
    return { ok: false, count: entry.count, remaining: 0, retryAfterMs: Math.max(1, entry.windowStart + windowMs - now) };
  }
  return { ok: true, count: entry.count, remaining: Math.max(0, max - entry.count), retryAfterMs: 0 };
}

/** Test helper — clear all rate limit buckets. */
export function resetRateLimits() {
  RATE_LIMIT_STORE.clear();
}

// ─── CORS (origin allowlist) ─────────────────────────────────────────

/**
 * Resolve the value for Access-Control-Allow-Origin, or null when the
 * request must not get a CORS echo:
 *   • no Origin header  → same-origin request, no header needed
 *   • Origin in config.allowedOrigins → echo it back verbatim
 *   • anything else     → null (browser blocks the cross-origin read)
 * An empty allowlist = same-origin only. Exported for tests.
 */
export function corsOriginFor(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
  return allowed.includes(origin) ? origin : null;
}

function applyCors(req, res) {
  const origin = corsOriginFor(req);
  // Vary on Origin so caches don't serve one origin's headers to another.
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return origin;
}

// ─── lazy imports — only loaded when an API route actually needs them ─
// This keeps the test for computeTrends() isolated from runManager.
let _runManager = null;
async function runManager() {
  if (!_runManager) {
    _runManager = await import('../src/services/runManager.js');
  }
  return _runManager;
}

let _report = null;
async function report() {
  if (!_report) {
    _report = await import('../src/services/report.js');
  }
  return _report;
}

let _monitors = null;
async function monitors() {
  if (!_monitors) {
    const { MonitorStore } = await import('../src/services/monitors.js');
    _monitors = new MonitorStore(DATA_DIR);
  }
  return _monitors;
}

// ─── record-once login (session capture) ─────────────────────────────

let _sessionStore = null;
async function sessionStore() {
  if (!_sessionStore) {
    const { SessionStore } = await import('../src/services/sessionStore.js');
    _sessionStore = new SessionStore({ dataDir: DATA_DIR });
  }
  return _sessionStore;
}

let _recorder = null;
async function recorder() {
  if (!_recorder) {
    const { LoginRecorder } = await import('../src/services/loginRecorder.js');
    _recorder = new LoginRecorder({ log: (...a) => console.log('[recorder]', ...a) });
  }
  return _recorder;
}

/** Lazy load runStore; null when the module or export hasn't landed yet. */
async function runStore() {
  try {
    const mod = await import('../src/storage/runStore.js');
    return mod;
  } catch {
    return null;
  }
}

/** Lazy load planDraftStore; null when the module hasn't landed yet. */
async function planDraftStore() {
  try {
    const mod = await import('../src/storage/planDraftStore.js');
    if (mod && typeof mod.getDraft === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/** Save a finished recording for a monitor (+ optional role) + stamp its state. */
async function persistRecording(monitorId, state, role) {
  const store = await sessionStore();
  const meta = await store.saveSession(monitorId, state, role || 'default');
  const monitorStore = await monitors();
  await monitorStore.update(monitorId, {
    sessionRecordedAt: meta.recordedAt,
    sessionExpired: false,
  });
  return meta;
}

// ─── URL / role sanitization ─────────────────────────────────────────

/**
 * Strip the query string (and fragment) from a recorded page URL — login
 * pages can carry password-reset tokens / OTP codes that must not leak
 * into the dashboard or logs. Exported for tests.
 */
export function sanitizeRecordedUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // Not a parseable URL — cheap fallback still removes the query.
    return raw.split('?')[0].split('#')[0];
  }
}

const ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * Sanitize a requested session role. Missing/empty → 'default';
 * malformed → null (caller turns that into a 400). Exported for tests.
 */
export function sanitizeRole(raw) {
  if (raw == null || raw === '') return 'default';
  return ROLE_PATTERN.test(String(raw)) ? String(raw) : null;
}

/** Coerce a roles field (array or comma-separated string) into a clean list. */
function normalizeRoles(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map(r => String(r).trim()).filter(Boolean))];
}

async function handleRecordLogin(res, monitorId, url) {
  try {
    const roleRaw = url.searchParams.get('role');
    const role = sanitizeRole(roleRaw);
    if (role === null) {
      sendError(res, 400, 'Invalid role — must match ^[a-zA-Z0-9_-]{1,32}$');
      return;
    }
    const monitorStore = await monitors();
    const monitor = await monitorStore.get(monitorId);
    if (!monitor) {
      sendError(res, 404, `Monitor not found: ${monitorId}`);
      return;
    }
    const rec = await recorder();
    await rec.start({
      monitorId,
      url: monitor.url,
      // role support is new in loginRecorder — pass it only when requested
      // so the current recorder signature stays untouched.
      ...(roleRaw ? { role } : {}),
      onDone: async (result) => {
        if (result.ok && result.state) {
          try {
            const meta = await persistRecording(monitorId, result.state, result.role || role);
            console.log(`[recorder] session saved for ${monitorId}${result.role || role ? ` (role: ${result.role || role})` : ''} (${meta.cookieCount} cookies)`);
          } catch (err) {
            console.error(`[recorder] failed to save session for ${monitorId}: ${err.message}`);
          }
        } else {
          console.log(`[recorder] recording ended for ${monitorId}: ${result.reason} — ${result.message || ''}`);
        }
      },
    });
    sendJson(res, 202, { started: true, monitorId, ...(roleRaw ? { role } : {}), message: 'A browser window opened — log in, then click "Save session" in the banner.' });
  } catch (err) {
    if (err.code === 'NO_DISPLAY') {
      sendError(res, 501, err.message);
      return;
    }
    sendError(res, 400, err.message);
  }
}

async function handleRecordStatus(res) {
  const rec = await recorder();
  const status = rec.getStatus();
  // Never surface the full recorded URL — it can contain reset tokens.
  if (status && typeof status.currentUrl === 'string') {
    status.currentUrl = sanitizeRecordedUrl(status.currentUrl);
  }
  sendJson(res, 200, status);
}

async function handleRecordCancel(res) {
  const rec = await recorder();
  const result = await rec.cancel('user-cancel-dashboard');
  sendJson(res, 200, result);
}

async function handleDeleteSession(res, monitorId, url) {
  try {
    const roleRaw = url.searchParams.get('role');
    const role = sanitizeRole(roleRaw);
    if (role === null) {
      sendError(res, 400, 'Invalid role — must match ^[a-zA-Z0-9_-]{1,32}$');
      return;
    }
    const store = await sessionStore();
    // Per-role sessions are landing in sessionStore — pass the role through
    // when given; the current single-session store ignores the extra arg.
    const deleted = await store.deleteSession(monitorId, ...(roleRaw ? [{ role }] : []));
    const monitorStore = await monitors();
    await monitorStore.update(monitorId, { sessionRecordedAt: null, sessionExpired: false });
    sendJson(res, 200, { deleted, monitorId, ...(roleRaw ? { role } : {}) });
  } catch (err) {
    sendError(res, 500, `Failed to delete session: ${err.message}`);
  }
}

/** GET /api/monitors/:id/sessions — list recorded sessions (per role when supported). */
async function handleListSessions(res, monitorId) {
  try {
    const store = await sessionStore();
    let sessions = null;
    if (typeof store.listSessions === 'function') {
      sessions = await store.listSessions(monitorId).catch(() => null);
    }
    if (!Array.isArray(sessions)) {
      const meta = await store.getSessionMeta(monitorId);
      sessions = meta && meta.exists ? [{ role: meta.role || 'default', ...meta }] : [];
    }
    sendJson(res, 200, { monitorId, sessions, count: sessions.length });
  } catch (err) {
    sendError(res, 500, `Failed to list sessions: ${err.message}`);
  }
}

// ─── MIME types ──────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── response helpers ────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sendAttachment(res, filename, body) {
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

// ─── auth (Rung 3) ───────────────────────────────────────────────────

/**
 * Constant-time string comparison for tokens: both sides are hashed with
 * sha256 first so the buffers are always equal length (timingSafeEqual
 * throws on length mismatch). Exported for tests.
 */
export function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || !expected || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

const TICKETS = new Map();
const TICKET_TTL_MS = 30_000;

export function createTicket() {
  const ticket = crypto.randomUUID();
  TICKETS.set(ticket, Date.now() + TICKET_TTL_MS);
  return ticket;
}

export function validateAndConsumeTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return false;
  const exp = TICKETS.get(ticket);
  if (!exp) return false;
  TICKETS.delete(ticket); // single use
  return Date.now() <= exp;
}

export function resetTickets() {
  TICKETS.clear();
}

/**
 * Token gate for the API. When SQA_API_TOKEN is set, every /api/* route
 * except /health requires it — via 'Authorization: Bearer <token>' or a
 * single-use '?ticket=' query param for GET streaming/download requests.
 * Static UI files stay open; the SPA collects the key and attaches it.
 *
 * Query-param persistent tokens (?token=...) are REJECTED to prevent
 * secrets from leaking into access logs, browser history, or Referer headers.
 *
 * No token configured = open mode (local development unchanged).
 *
 * @returns {boolean}
 */
export function isAuthorized(req, url, token = process.env.SQA_API_TOKEN || '') {
  if (!token) return true;
  const pathname = url.pathname;
  if (pathname === '/health') return true;
  if (!pathname.startsWith('/api/')) return true;

  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ') && safeTokenEqual(header.slice('Bearer '.length), token)) return true;

  // Single-use ticket via query param for GET requests (SSE / reports / screenshots)
  const ticket = url.searchParams.get('ticket');
  if (ticket && (req.method === 'GET' || !req.method)) {
    return validateAndConsumeTicket(ticket);
  }

  // Reject ?token= to prevent long-lived credential leakage via URL / Referer
  return false;
}

/**
 * CSRF Guard for state-mutating API requests (POST, PUT, PATCH, DELETE).
 * Verifies Host, Sec-Fetch-Site, Origin, and Content-Type.
 */
export function csrfGuard(req, res) {
  const method = req.method;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!url.pathname.startsWith('/api/')) return true;

  // 1. Host header validation: prevent DNS rebinding / host header injection
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  if (config.bindHost) {
    allowedHosts.add(config.bindHost.toLowerCase());
  }
  if (host && !allowedHosts.has(host) && process.env.NODE_ENV !== 'test') {
    sendError(res, 403, 'Forbidden: untrusted Host header');
    return false;
  }

  // 2. Sec-Fetch-Site check (modern browsers)
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite === 'cross-site') {
    sendError(res, 403, 'Forbidden: cross-site request blocked');
    return false;
  }

  // 3. Origin check if present
  const origin = req.headers.origin;
  if (origin) {
    const allowed = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
    let originUrl = null;
    try { originUrl = new URL(origin); } catch {}
    const isAllowed = allowed.includes(origin) ||
      (originUrl && allowedHosts.has(originUrl.hostname.toLowerCase()));
    if (!isAllowed) {
      sendError(res, 403, 'Forbidden: cross-origin mutation not permitted');
      return false;
    }
  }

  // 4. Content-Type check for state-mutating requests with a body (POST, PUT, PATCH)
  const contentType = req.headers['content-type'];
  const hasBody = req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 0;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (contentType) {
      const ct = contentType.toLowerCase();
      if (!ct.startsWith('application/json') && !ct.startsWith('application/octet-stream')) {
        sendError(res, 415, 'Unsupported Media Type: application/json required for API mutations');
        return false;
      }
    } else if (hasBody) {
      sendError(res, 415, 'Unsupported Media Type: application/json required for API mutations');
      return false;
    }
  }

  return true;
}

async function sendStaticFile(res, filePath) {
  try {
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendError(res, 404, 'File not found');
    } else {
      sendError(res, 500, err.message);
    }
  }
}

// ─── route handlers ──────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * POST /api/plan — draft a test plan for human review (human-in-the-loop).
 * Body: { url, options? } → { draftId, plan }
 */
async function handleCreatePlan(req, res) {
  try {
    const body = await readJsonBody(req);
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      sendError(res, 400, 'Missing url field');
      return;
    }
    const rm = await runManager();
    if (typeof rm.draftPlan !== 'function') {
      sendError(res, 501, 'Plan drafting is not wired up yet (runManager.draftPlan is missing) — use the quick "Start Test" path.');
      return;
    }
    const options = (body.options && typeof body.options === 'object' && !Array.isArray(body.options)) ? body.options : {};
    const { draftId, plan } = await rm.draftPlan(url, options);
    sendJson(res, 200, { draftId, plan });
  } catch (err) {
    sendError(res, 502, `Could not draft plan: ${err.message}`);
  }
}

async function handleCreateRun(req, res) {
  try {
    const payload = await readJsonBody(req);
    const { url, options = {}, mode = 'matrix', plan } = payload;
    const planDraftId = typeof payload.planDraftId === 'string' ? payload.planDraftId.trim() : '';

    if (!url && !planDraftId) {
      sendError(res, 400, 'Missing url field (or planDraftId)');
      return;
    }

    let effectiveUrl = url;
    let effectivePlan = plan;

    // Human-approved plan path: resolve + mark the draft approved, then run it.
    if (planDraftId) {
      const pds = await planDraftStore();
      if (!pds) {
        sendError(res, 501, 'Plan review storage (planDraftStore) is not available yet — use the quick "Start Test" path.');
        return;
      }
      const draft = await pds.getDraft(planDraftId);
      if (!draft) {
        sendError(res, 404, `Plan draft not found: ${planDraftId}`);
        return;
      }
      // An explicitly submitted plan (checkbox-trimmed by the reviewer) wins
      // over the stored draft; createRunWithMatrix may also accept planDraftId
      // directly once that integration lands — it is forwarded below.
      effectivePlan = plan || draft.plan || null;
      effectiveUrl = url || draft.url || draft.plan?.targetUrl;
      if (!effectiveUrl) {
        sendError(res, 400, 'Plan draft has no target URL');
        return;
      }
      if (effectivePlan) {
        const { validateTestPlan } = await import('../src/services/testPlan.js');
        const verdict = validateTestPlan(effectivePlan);
        if (!verdict.ok) {
          const detail = verdict.error.map(e => `${e.path}: ${e.message}`).join('; ');
          sendError(res, 400, `Invalid approved plan: ${detail}`);
          return;
        }
      }
      try {
        await pds.markApproved(planDraftId);
      } catch (err) {
        sendError(res, 500, `Could not approve plan draft: ${err.message}`);
        return;
      }
    }

    const { createRun, createRunWithMatrix } = await runManager();
    const { registerAllExecutors } = await import('../src/executors/index.js');
    registerAllExecutors();
    const { registerLegacyChecks } = await import('../src/checks/index.js');
    registerLegacyChecks();

    let runId;
    if (mode === 'legacy') {
      runId = await createRun(effectiveUrl, options);
    } else {
      runId = await createRunWithMatrix({
        url: effectiveUrl,
        options,
        plan: effectivePlan,
        ...(planDraftId ? { planDraftId } : {}),
      });
    }
    sendJson(res, 202, { runId, mode, ...(planDraftId ? { planDraftId } : {}) });
  } catch (err) {
    sendError(res, 400, `Failed to create run: ${err.message}`);
  }
}

async function handleCancelRun(res, runId) {
  const { cancelRun } = await runManager();
  const result = await cancelRun(runId);
  if (!result.ok) {
    sendError(res, result.reason === 'not-found' ? 404 : 409, result.reason === 'not-found' ? 'Run not found' : `Run is ${result.status}`);
    return;
  }
  sendJson(res, 200, result);
}

// ─── monitor handlers (Rung 3) ───────────────────────────────────────

async function handleListMonitors(res) {
  try {
    const store = await monitors();
    const { nextRunAt } = await import('../src/services/monitors.js');
    const ss = await sessionStore();
    const list = await store.list();
    const withSession = await Promise.all(list.map(async m => {
      const meta = await ss.getSessionMeta(m.id);
      // Per-role sessions when the store supports them; otherwise the single
      // recorded session is presented as one 'default' entry.
      let sessions = null;
      if (typeof ss.listSessions === 'function') {
        sessions = await ss.listSessions(m.id).catch(() => null);
      }
      if (!Array.isArray(sessions)) {
        sessions = meta && meta.exists ? [{ role: meta.role || 'default', ...meta }] : [];
      }
      return {
        ...m,
        nextRunAt: nextRunAt(m),
        session: meta,
        sessions,
      };
    }));
    sendJson(res, 200, {
      monitors: withSession,
      count: withSession.length,
      schedulerEnabled: process.env.SQA_SCHEDULER_ENABLED !== 'false',
      authRequired: Boolean(process.env.SQA_API_TOKEN),
    });
  } catch (err) {
    sendError(res, 500, `Failed to list monitors: ${err.message}`);
  }
}

async function handleCreateMonitor(req, res) {
  try {
    const body = await readJsonBody(req);
    const store = await monitors();
    const roles = body.roles !== undefined ? normalizeRoles(body.roles) : undefined;
    const invalidRole = (roles || []).find(r => !ROLE_PATTERN.test(r));
    if (invalidRole) {
      sendError(res, 400, `Invalid role: "${invalidRole}" — roles must match ^[a-zA-Z0-9_-]{1,32}$`);
      return;
    }
    if (body.webhookUrl) {
      const { validateUrl } = await import('../src/services/ssrf.js');
      await validateUrl(body.webhookUrl);
    }
    const payload = {
      id: body.id,
      label: body.label || body.id,
      url: body.url,
      options: body.options || {},
      intervalHours: body.intervalHours ?? 24,
      enabled: body.enabled ?? true,
      onlyNewFindings: body.onlyNewFindings ?? true,
      webhookUrl: body.webhookUrl || '',
      ...(roles !== undefined ? { roles } : {}),
    };
    let result = await store.add(payload);
    // Graceful interim: if the monitor schema is strict and doesn't know
    // `roles` yet, retry without it and merge roles via update() instead.
    if (!result.ok && roles !== undefined && /roles/i.test(result.error || '')) {
      const { roles: _omit, ...withoutRoles } = payload;
      result = await store.add(withoutRoles);
      if (result.ok) {
        try { await store.update(result.monitor.id, { roles }); } catch { /* best effort */ }
      }
    }
    if (!result.ok) {
      sendError(res, 400, result.error);
      return;
    }
    sendJson(res, 201, { monitor: result.monitor });
  } catch (err) {
    sendError(res, 400, `Failed to create monitor: ${err.message}`);
  }
}

/** PUT /api/monitors/:id — partial update (label/url/interval/roles/enabled/…). */
async function handleUpdateMonitor(req, res, id) {
  try {
    const body = await readJsonBody(req);
    const store = await monitors();
    const existing = await store.get(id);
    if (!existing) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    const patch = {};
    if (body.label !== undefined) {
      const label = String(body.label).trim().slice(0, 120);
      if (!label) { sendError(res, 400, 'label must not be empty'); return; }
      patch.label = label;
    }
    if (body.url !== undefined) {
      const url = String(body.url).trim();
      try { new URL(url); } catch { sendError(res, 400, 'url must be a valid URL'); return; }
      patch.url = url;
    }
    if (body.intervalHours !== undefined) {
      const hours = Number(body.intervalHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
        sendError(res, 400, 'intervalHours must be between 1 and 720');
        return;
      }
      patch.intervalHours = hours;
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.onlyNewFindings !== undefined) patch.onlyNewFindings = Boolean(body.onlyNewFindings);
    if (body.webhookUrl !== undefined) {
      const wUrl = String(body.webhookUrl || '').trim();
      if (wUrl) {
        const { validateUrl } = await import('../src/services/ssrf.js');
        await validateUrl(wUrl);
      }
      patch.webhookUrl = wUrl;
    }
    if (body.options !== undefined && body.options && typeof body.options === 'object' && !Array.isArray(body.options)) {
      patch.options = { ...(existing.options || {}), ...body.options };
    }
    if (body.roles !== undefined) {
      const roles = normalizeRoles(body.roles);
      const invalidRole = roles.find(r => !ROLE_PATTERN.test(r));
      if (invalidRole) {
        sendError(res, 400, `Invalid role: "${invalidRole}" — roles must match ^[a-zA-Z0-9_-]{1,32}$`);
        return;
      }
      patch.roles = roles;
    }
    const updated = await store.update(id, patch);
    if (!updated) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    sendJson(res, 200, { monitor: updated });
  } catch (err) {
    sendError(res, 400, `Failed to update monitor: ${err.message}`);
  }
}

async function handleDeleteMonitor(res, id) {
  try {
    const store = await monitors();
    const removed = await store.remove(id);
    if (!removed) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    sendJson(res, 200, { deleted: id });
  } catch (err) {
    sendError(res, 500, `Failed to delete monitor: ${err.message}`);
  }
}

async function handleRunMonitor(res, id) {
  try {
    const store = await monitors();
    const monitor = await store.get(id);
    if (!monitor) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    // Trigger immediately with monitoring metadata, mirroring the scheduler
    const { triggerMonitor } = await import('../src/services/scheduler.js');
    const rm = await runManager();
    const runId = await triggerMonitor(monitor, {
      monitorStore: store,
      createRun: (input) => rm.createRunWithMatrix(input),
      log: console.log,
    });
    sendJson(res, 202, { runId, monitorId: id });
  } catch (err) {
    sendError(res, 400, `Failed to run monitor: ${err.message}`);
  }
}

async function handleListRuns(res) {
  try {
    const { listRuns } = await runManager();
    const runs = await listRuns();
    sendJson(res, 200, { runs, count: runs.length });
  } catch (err) {
    sendError(res, 500, `Failed to list runs: ${err.message}`);
  }
}

/** Load triage states for a run — null when runStore hasn't landed them yet. */
async function loadTriageStates(runId) {
  try {
    const rs = await runStore();
    if (!rs || typeof rs.getFindingStates !== 'function') return null;
    const states = await rs.getFindingStates(runId);
    if (!states) return null;
    return states instanceof Map ? Object.fromEntries(states) : states;
  } catch {
    return null;
  }
}

/** Load the persisted plan for a run — null when unavailable. */
async function loadRunPlan(runId) {
  try {
    const rs = await runStore();
    if (!rs || typeof rs.getPlan !== 'function') return null;
    return await rs.getPlan(runId);
  } catch {
    return null;
  }
}

async function handleGetRun(res, runId) {
  try {
    const { getRun } = await runManager();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }
    const payload = { ...run };

    // Merge triage states into findings (default 'open')
    if (Array.isArray(run.findings) && run.findings.length > 0) {
      const states = await loadTriageStates(runId);
      if (states) {
        payload.findings = run.findings.map(f => ({
          ...f,
          triageState: states[`${f.ruleId}|${f.pageUrl}`] || 'open',
        }));
      }
    }

    // Attach the approved test plan when the run record doesn't carry one.
    if (!payload.plan) {
      const plan = await loadRunPlan(runId);
      if (plan) payload.plan = plan;
    }

    sendJson(res, 200, payload);
  } catch (err) {
    sendError(res, 500, `Failed to fetch run: ${err.message}`);
  }
}

const TRIAGE_STATES = ['open', 'acknowledged', 'false_positive', 'fixed'];

/**
 * PATCH /api/runs/:id/findings — set the triage state of one finding.
 * Body: { ruleId, pageUrl, state } with state ∈ TRIAGE_STATES.
 */
async function handlePatchFindingState(req, res, runId) {
  try {
    const body = await readJsonBody(req);
    const ruleId = typeof body.ruleId === 'string' ? body.ruleId.trim() : '';
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl.trim() : '';
    const { state } = body;

    if (!ruleId) { sendError(res, 400, 'Missing ruleId'); return; }
    if (!pageUrl) { sendError(res, 400, 'Missing pageUrl'); return; }
    if (!TRIAGE_STATES.includes(state)) {
      sendError(res, 400, `Invalid state — must be one of: ${TRIAGE_STATES.join(', ')}`);
      return;
    }

    const { getRun } = await runManager();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }

    const rs = await runStore();
    if (!rs || typeof rs.setFindingState !== 'function') {
      sendError(res, 501, 'Finding triage storage (runStore.setFindingState) is not available yet.');
      return;
    }
    await rs.setFindingState(runId, ruleId, pageUrl, state);
    sendJson(res, 200, { ok: true, runId, ruleId, pageUrl, state });
  } catch (err) {
    sendError(res, 400, `Failed to set finding state: ${err.message}`);
  }
}

/**
 * GET /api/runs/:id/diff?against=:otherId — run-to-run comparison.
 * Without ?against, the most recent earlier run for the same URL is used.
 * The ?against run is the BASELINE: newFindings are what appeared in :id.
 */
async function handleRunDiff(res, runId, url) {
  const { getRun, listRuns } = await runManager();
  const currentRun = await getRun(runId);
  if (!currentRun) {
    sendError(res, 404, `Run not found: ${runId}`);
    return;
  }
  let againstId = url.searchParams.get('against');
  if (!againstId) {
    const runs = await listRuns({ url: currentRun.url, limit: 50 });
    const earlier = runs
      .filter(r => r.runId !== currentRun.runId && r.startedAt && currentRun.startedAt && String(r.startedAt) < String(currentRun.startedAt))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
    if (!earlier) {
      sendError(res, 404, 'No earlier run for this URL to compare against');
      return;
    }
    againstId = earlier.runId;
  }
  const baselineRun = await getRun(againstId);
  if (!baselineRun) {
    sendError(res, 404, `Run not found: ${againstId}`);
    return;
  }
  const { diffRuns } = await import('../src/services/runDiff.js');
  const diff = diffRuns(baselineRun, currentRun);
  sendJson(res, 200, {
    runId: currentRun.runId,
    against: baselineRun.runId,
    scoreA: baselineRun.score ?? null,
    scoreB: currentRun.score ?? null,
    ...diff,
  });
}

/** GET /api/runs/:id/evidence — WCAG evidence report (JSON attachment). */
async function handleEvidence(res, runId) {
  const { getRun } = await runManager();
  const run = await getRun(runId);
  if (!run) {
    sendError(res, 404, `Run not found: ${runId}`);
    return;
  }
  let compliance = null;
  try {
    compliance = await import('../src/services/compliance.js');
  } catch { /* module not landed yet */ }
  if (!compliance || typeof compliance.buildEvidenceReport !== 'function') {
    sendError(res, 501, 'WCAG evidence export is not available yet — compliance.buildEvidenceReport has not landed.');
    return;
  }
  const evidence = compliance.buildEvidenceReport(run, {});
  sendAttachment(res, `evidence-${runId}.json`, JSON.stringify(evidence, null, 2));
}

/** GET /api/runs/:id/findings/:fid/evidence[?shareable=true] — finding evidence bundle (ZIP). */
async function handleFindingEvidence(res, runId, findingId, shareable) {
  const rm = await runManager();
  const run = await rm.getRun(runId);
  if (!run) {
    sendError(res, 404, `Run not found: ${runId}`);
    return;
  }
  const finding = (run.findings || []).find(
    (f) => String(f.id || '') === String(findingId) || String(f.ruleId || '') === String(findingId),
  );
  if (!finding) {
    sendError(res, 404, `Finding not found in run ${runId}: ${findingId}`);
    return;
  }
  let bundle;
  try {
    const { buildFindingEvidenceBundle } = await import('../src/services/evidenceBundle.js');
    bundle = buildFindingEvidenceBundle({
      run,
      finding,
      evidenceDir: rm.evidenceDirFor(runId),
      shareable: shareable === true,
      toolVersion: PKG_VERSION,
    });
  } catch (err) {
    sendError(res, 500, `Evidence bundle failed: ${err.message}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${bundle.filename}"`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(bundle.buffer);
}

const PUBLISH_TARGETS = ['testrail', 'xray'];

/** POST /api/runs/:id/publish — push results to an external test-management tool. */
async function handlePublishRun(req, res, runId) {
  try {
    const body = await readJsonBody(req);
    const target = typeof body.target === 'string' ? body.target.trim().toLowerCase() : '';
    if (!PUBLISH_TARGETS.includes(target)) {
      sendError(res, 400, `Invalid target — must be one of: ${PUBLISH_TARGETS.join(', ')}`);
      return;
    }
    const { getRun } = await runManager();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }
    let publisher = null;
    try {
      publisher = await import('../src/integrations/testResultsPublisher.js');
    } catch { /* module not landed yet */ }
    if (!publisher || typeof publisher.publishRunResults !== 'function') {
      sendError(res, 501, `Publishing to ${target} is not available yet — integrations/testResultsPublisher.js has not landed.`);
      return;
    }
    const result = await publisher.publishRunResults(run, { target });
    // Whitelist the echoed fields — never reflect environment values back.
    sendJson(res, 200, {
      ok: Boolean(result && result.ok),
      target,
      runId,
      details: result && result.details != null ? result.details : null,
    });
  } catch (err) {
    sendError(res, 502, `Publish failed: ${err.message}`);
  }
}

async function handleGetReport(res, runId, format) {
  try {
    const { getRun } = await runManager();
    const { generateHtmlReport, generateJsonReport, generatePdfReport } = await report();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }
    if (format === 'pdf') {
      const pdf = await generatePdfReport(run, {
        publicUrl: `http://localhost:${process.env.SQA_DASHBOARD_PORT || 8080}`,
      });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${runId}.pdf"`,
      });
      res.end(pdf);
      return;
    }
    if (format === 'json') {
      const body = generateJsonReport(run);
      sendAttachment(res, `${runId}.json`, body);
    } else {
      const body = generateHtmlReport(run);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(body);
    }
  } catch (err) {
    sendError(res, 500, `Failed to generate report: ${err.message}`);
  }
}

async function handleScreenshot(res, runId, filename) {
  // Sanitize filename — prevent path traversal
  const safe = path.basename(filename);
  if (safe !== filename) {
    sendError(res, 400, 'Invalid filename');
    return;
  }
  // Run-scoped access: screenshots are saved as `<runId>_<slug>_…` (or with a
  // dash separator) — a filename from a DIFFERENT run must never be served.
  if (!safe.startsWith(`${runId}_`) && !safe.startsWith(`${runId}-`)) {
    sendError(res, 404, 'Screenshot not found for this run');
    return;
  }
  const filePath = path.join(SCREENSHOTS_DIR, safe);
  await sendStaticFile(res, filePath);
}

async function handleTrends(res) {
  try {
    const { listRuns } = await runManager();
    const runs = await listRuns();
    const trends = computeTrends(runs);

    // Phase 6: include flaky test detection from recorded history
    try {
      const { FlakyTracker } = await import('../src/matrix/flakyTracker.js');
      const tracker = new FlakyTracker({ dataDir: DATA_DIR });
      trends.flakyTests = await tracker.detectFlakyTests();
    } catch (err) {
      // Flaky tracking is best-effort — don't fail the whole trends endpoint
      trends.flakyTests = [];
      trends.flakyError = err.message;
    }

    sendJson(res, 200, trends);
  } catch (err) {
    sendError(res, 500, `Failed to compute trends: ${err.message}`);
  }
}

/**
 * Health check endpoint — used by load balancers / container orchestrators.
 * Returns 200 if the server can read the data dir + respond to requests.
 */
async function handleHealth(res) {
  try {
    const dataDirExists = existsSync(DATA_DIR);
    const screenshotsDirExists = existsSync(SCREENSHOTS_DIR);
    sendJson(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      dataDir: DATA_DIR,
      dataDirExists,
      screenshotsDirExists,
      memoryUsage: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, 500, `Health check failed: ${err.message}`);
  }
}

/**
 * GET /api/flaky — return the flaky test list (Phase 6).
 */
async function handleFlaky(res) {
  try {
    const { FlakyTracker } = await import('../src/matrix/flakyTracker.js');
    const tracker = new FlakyTracker({ dataDir: DATA_DIR });
    const flakyTests = await tracker.detectFlakyTests();
    const stats = await tracker.stats();
    sendJson(res, 200, { flakyTests, stats });
  } catch (err) {
    sendError(res, 500, `Failed to compute flaky tests: ${err.message}`);
  }
}

/**
 * Compute aggregate trends from the run list.
 * Returns:
 *   • totalRuns, completedRuns, failedRuns
 *   • avgScore, scoreTrend (last 10 runs)
 *   • findingsBySeverity (sum across all runs)
 *   • findingsByCategory (sum)
 *   • flakyTests: tests that pass on some runs and fail on others
 */
export function computeTrends(runs) {
  const completed = runs.filter(r => r.status === 'completed');
  const failed = runs.filter(r => r.status === 'failed');

  const scores = completed.map(r => r.score).filter(s => s != null);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null;

  // Score trend: last 10 completed runs (oldest first for chart)
  const scoreTrend = completed
    .slice(-10)
    .reverse()
    .map(r => ({
      runId: r.runId,
      url: r.url,
      startedAt: r.startedAt,
      score: r.score,
    }));

  // Aggregate findings across runs
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = {};
  const ruleIdCounts = new Map();  // ruleId → { count, occurrences, pages: Set }

  for (const run of completed) {
    const s = run.summary || {};
    if (s.bySeverity) {
      for (const [sev, count] of Object.entries(s.bySeverity)) {
        bySeverity[sev] = (bySeverity[sev] || 0) + count;
      }
    }
    if (s.byCategory) {
      for (const [cat, count] of Object.entries(s.byCategory)) {
        byCategory[cat] = (byCategory[cat] || 0) + count;
      }
    }
  }

  // Flaky test detection: same ruleId appears in some runs but not others
  // (Phase 6 will implement a proper flaky tracker; this is a heuristic)
  const flakyTests = [];

  return {
    totalRuns: runs.length,
    completedRuns: completed.length,
    failedRuns: failed.length,
    avgScore,
    scoreTrend,
    findingsBySeverity: bySeverity,
    findingsByCategory: byCategory,
    flakyTests,
  };
}

// ─── Single-use auth ticket handler ──────────────────────────────────

async function handleCreateTicket(res) {
  const ticket = createTicket();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  sendJson(res, 200, { ticket });
}

// ─── SSE handler ──────────────────────────────────────────────────────

async function handleSSE(req, res, runId) {
  const { getRun, addSSEClient, removeSSEClient } = await runManager();

  // Verify the run exists
  const run = await getRun(runId);
  if (!run) {
    sendError(res, 404, `Run not found: ${runId}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, no-transform',
    'Referrer-Policy': 'no-referrer',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering
  });

  // Send existing events first (replay)
  if (run.events) {
    for (const evt of run.events) {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...evt })}\n\n`);
    }
  }

  // If the run is already done, send terminal marker
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    res.write(`data: ${JSON.stringify({ type: 'progress', message: '__DONE__', timestamp: run.completedAt })}\n\n`);
  } else {
    // Register for live updates
    addSSEClient(runId, res);
    req.on('close', () => removeSSEClient(runId, res));
  }
}

// ─── router ──────────────────────────────────────────────────────────

/** Entry point — helmet headers first, then the async router. */
export function route(req, res) {
  try {
    helmetMiddleware(req, res, () => {
      handleRoute(req, res).catch(err => {
        console.error('Route error:', err);
        try {
          sendError(res, 500, err.message);
        } catch { /* response already closed */ }
      });
    });
  } catch (err) {
    console.error('Middleware error:', err);
    try { sendError(res, 500, err.message); } catch { /* already closed */ }
  }
}

async function handleRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS — echo the Origin only when it is allow-listed (empty list = same-origin only)
  applyCors(req, res);
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // CSRF guard on mutating API endpoints
  if (!csrfGuard(req, res)) {
    return;
  }

  // Token gate (Rung 3) — see isAuthorized()
  if (!isAuthorized(req, url)) {
    sendError(res, 401, 'Unauthorized — a valid access key is required');
    return;
  }

  // Rate limiting — fixed window per IP on /api/* routes. Skipped entirely
  // under NODE_ENV=test so test suites don't trip the budgets.
  if (pathname.startsWith('/api/') && process.env.NODE_ENV !== 'test') {
    const ip = req.socket?.remoteAddress || 'unknown';
    const isRunCreate = pathname === '/api/runs' && method === 'POST';
    const max = isRunCreate ? Math.max(1, config.rateLimitMaxRuns || 5) : RATE_LIMIT_GENERAL_MAX;
    const verdict = checkRateLimit(`${isRunCreate ? 'runs' : 'api'}:${ip}`, { max });
    if (!verdict.ok) {
      res.setHeader('Retry-After', Math.ceil(verdict.retryAfterMs / 1000));
      sendError(res, 429, `Too many requests — limit is ${max} per ${Math.round(RATE_LIMIT_WINDOW_MS / 60000)} minutes. Retry in ${Math.ceil(verdict.retryAfterMs / 1000)}s.`);
      return;
    }
  }

  try {
    // API routes
    if (pathname === '/api/ticket' && method === 'POST') {
      return await handleCreateTicket(res);
    }
    if (pathname === '/api/runs' && method === 'GET') {
      return await handleListRuns(res);
    }
    if (pathname === '/api/runs' && method === 'POST') {
      return await handleCreateRun(req, res);
    }
    if (pathname === '/api/plan' && method === 'POST') {
      return await handleCreatePlan(req, res);
    }
    if (pathname === '/api/trends' && method === 'GET') {
      return await handleTrends(res);
    }
    if (pathname === '/health' && method === 'GET') {
      return await handleHealth(res);
    }
    if (pathname === '/api/flaky' && method === 'GET') {
      return await handleFlaky(res);
    }

    // Monitor routes (Rung 3)
    if (pathname === '/api/monitors' && method === 'GET') {
      return await handleListMonitors(res);
    }
    if (pathname === '/api/monitors' && method === 'POST') {
      return await handleCreateMonitor(req, res);
    }
    const monitorDeleteMatch = pathname.match(/^\/api\/monitors\/([^/]+)$/);
    if (monitorDeleteMatch && method === 'DELETE') {
      return await handleDeleteMonitor(res, monitorDeleteMatch[1]);
    }
    const monitorPutMatch = pathname.match(/^\/api\/monitors\/([^/]+)$/);
    if (monitorPutMatch && method === 'PUT') {
      return await handleUpdateMonitor(req, res, monitorPutMatch[1]);
    }
    const monitorSessionsMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/sessions$/);
    if (monitorSessionsMatch && method === 'GET') {
      return await handleListSessions(res, monitorSessionsMatch[1]);
    }
    const monitorRunMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/run$/);
    if (monitorRunMatch && method === 'POST') {
      return await handleRunMonitor(res, monitorRunMatch[1]);
    }
    const recordLoginMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/record-login$/);
    if (recordLoginMatch && method === 'POST') {
      return await handleRecordLogin(res, recordLoginMatch[1], url);
    }
    const deleteSessionMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/session$/);
    if (deleteSessionMatch && method === 'DELETE') {
      return await handleDeleteSession(res, deleteSessionMatch[1], url);
    }
    if (pathname === '/api/record-status' && method === 'GET') {
      return await handleRecordStatus(res);
    }
    if (pathname === '/api/record-cancel' && method === 'POST') {
      return await handleRecordCancel(res);
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      return await handleGetRun(res, runMatch[1]);
    }

    const findingsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/findings$/);
    if (findingsMatch && method === 'PATCH') {
      return await handlePatchFindingState(req, res, findingsMatch[1]);
    }

    const diffMatch = pathname.match(/^\/api\/runs\/([^/]+)\/diff$/);
    if (diffMatch && method === 'GET') {
      return await handleRunDiff(res, diffMatch[1], url);
    }

    const evidenceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/evidence$/);
    if (evidenceMatch && method === 'GET') {
      return await handleEvidence(res, evidenceMatch[1]);
    }

    // Phase 4: finding evidence bundles — default (unredacted) and shareable
    // (scrubbed HAR + trace metadata, NO video/screenshots) tiers.
    const findingEvidenceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/findings\/([^/]+)\/evidence$/);
    if (findingEvidenceMatch && method === 'GET') {
      return await handleFindingEvidence(
        res,
        findingEvidenceMatch[1],
        decodeURIComponent(findingEvidenceMatch[2]),
        url.searchParams.get('shareable') === 'true',
      );
    }

    const publishMatch = pathname.match(/^\/api\/runs\/([^/]+)\/publish$/);
    if (publishMatch && method === 'POST') {
      return await handlePublishRun(req, res, publishMatch[1]);
    }

    const cancelRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelRunMatch && method === 'POST') {
      return await handleCancelRun(res, cancelRunMatch[1]);
    }

    const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch && method === 'GET') {
      return await handleSSE(req, res, eventsMatch[1]);
    }

    const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report\.(json|html|pdf)$/);
    if (reportMatch && method === 'GET') {
      return await handleGetReport(res, reportMatch[1], reportMatch[2]);
    }

    const screenshotMatch = pathname.match(/^\/api\/runs\/([^/]+)\/screenshots\/(.+)$/);
    if (screenshotMatch && method === 'GET') {
      return await handleScreenshot(res, screenshotMatch[1], screenshotMatch[2]);
    }

    // Static files
    if (pathname === '/' || pathname === '/index.html') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/styles.css') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'styles.css'));
    }
    if (pathname === '/app.js') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'app.js'));
    }

    sendError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (err) {
    console.error('Route error:', err);
    sendError(res, 500, err.message);
  }
}

// ─── graceful shutdown (SIGTERM / SIGINT) ─────────────────────────────

let _schedulerInstance = null;

/**
 * Register SIGTERM/SIGINT handlers: stop the scheduler, shut the run manager
 * down (both guarded — those exports may still be landing), then exit 0.
 */
export function registerSignalHandlers({ log = (...a) => console.log('[shutdown]', ...a) } = {}) {
  const shutdown = async (signal) => {
    log(`Received ${signal} — shutting down…`);
    try {
      if (_schedulerInstance && typeof _schedulerInstance.stop === 'function') {
        _schedulerInstance.stop();
      }
    } catch { /* best effort */ }
    try {
      const rm = await runManager();
      if (typeof rm.shutdown === 'function') {
        await rm.shutdown();
      }
    } catch (err) {
      log(`runManager shutdown failed: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ─── server factory ───────────────────────────────────────────────────

export function createDashboardServer({ port = DEFAULT_PORT } = {}) {
  const server = http.createServer(route);
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      // Production safety: an unauthenticated dashboard must never go live.
      if (config.nodeEnv === 'production' && !config.apiToken) {
        const msg = 'FATAL: refusing to start — SQA_API_TOKEN must be set when NODE_ENV=production.';
        console.error(msg);
        reject(new Error(msg));
        return;
      }
      // Bind to loopback by default — config.bindHost opts into anything wider.
      const bindHost = config.bindHost || '127.0.0.1';
      if (bindHost === '0.0.0.0') {
        console.warn('⚠ SECURITY WARNING: binding to 0.0.0.0 — the dashboard API is reachable from ALL network interfaces.');
        console.warn('  Set SQA_BIND_HOST=127.0.0.1 (or unset it) to restrict access to localhost.');
      }
      server.listen(port, bindHost, () => {
        console.log(`SQA dashboard running at http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${port}`);
        // Rung 3: monitoring loop — no-op unless monitors are configured,
        // and disabled entirely with SQA_SCHEDULER_ENABLED=false.
        Promise.all([monitors(), runManager()])
          .then(([store]) => import('../src/services/scheduler.js'))
          .then(({ startScheduler }) => {
            _schedulerInstance = startScheduler({
              monitorStore: _monitors,
              createRun: (input) => runManager().then(m => m.createRunWithMatrix(input)),
              getRun: (id) => runManager().then(m => m.getRun(id)),
              log: (...args) => console.log('[scheduler]', ...args),
            });
          })
          .catch(err => console.error('Scheduler startup failed:', err.message));
        resolve(server);
      });
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Run if invoked directly (not imported)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { listen } = createDashboardServer();
  listen()
    .then(() => registerSignalHandlers())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
