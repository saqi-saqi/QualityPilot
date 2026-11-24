/**
 * executors/e2e.js — Playwright-driven flow runner.
 *
 * Consumes: plan.flows[]
 * Produces: findings when a flow's assertions fail or a step throws
 *
 * The step dispatcher (`runStep`) is the unit-testable core: it accepts a
 * page object with the standard Playwright Locator API and dispatches each
 * step action. Tests inject a MockPage that records calls and controls
 * assertion outcomes. The full executor wraps runFlow in retries (per
 * flow.retry) and emits findings on failure.
 *
 * Safety + resilience features:
 *   • URL safety — every `navigate` value, `startUrl`, and `api-request` URL
 *     goes through ssrf.validateUrl() plus a hard scheme check (http/https
 *     only; file:/data:/ftp: are always rejected) and a same-origin check
 *     against the run target unless the flow declares allowCrossOrigin.
 *     Rejected URLs emit an `e2e-unsafe-url` finding and skip the step.
 *   • Self-healing selectors — when a step's selector matches nothing, the
 *     deterministic fallback ladder in selectorResolver.js is tried; a
 *     healed step emits "selector self-healed: A → B" and records healedTo.
 *   • Hybrid API steps — action 'api-request' performs a fetch with status /
 *     JSON-path assertions and can save values into the flow variable scope.
 *   • Variables — ${VAR} placeholders in any step value resolve from the
 *     flow scope first, then services/testData.js (data/testdata.json +
 *     SQA_TD_* env vars). Unknown placeholders warn and stay literal.
 *   • Failure evidence — failed flows capture a screenshot into the
 *     screenshots dir and reference it in the finding evidence.
 */

import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateUrl, safeFetch } from '../services/ssrf.js';
import * as testData from '../services/testData.js';
import { resolveLocatorDetailed } from './selectorResolver.js';
import { config } from '../utils/config.js';
import { waitForPageReady } from '../utils/pageReady.js';

const STEP_TIMEOUT_DEFAULT_MS = 5000;
const API_TIMEOUT_DEFAULT_MS = 15000;
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024; // 10 MB cap

/**
 * Resolve an upload file path strictly confined within the uploads sandbox.
 * Rejects path traversal, non-existent files, non-regular files, symlinks targeting outside,
 * and files exceeding the size limit.
 */
export function resolveUpload(name, customUploadDir) {
  const baseDir = customUploadDir || path.resolve(config.dataDir || './data', 'uploads');
  if (!syncFs.existsSync(baseDir)) {
    syncFs.mkdirSync(baseDir, { recursive: true });
  }
  const realBase = syncFs.realpathSync(baseDir);
  const full = path.resolve(realBase, String(name || ''));
  let real;
  try {
    real = syncFs.realpathSync(full);
  } catch {
    throw new Error(`Upload file not found: ${name}`);
  }
  const rel = path.relative(realBase, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Upload outside sandbox: ${name}`);
  }
  const st = syncFs.statSync(real);
  if (!st.isFile()) {
    throw new Error(`Upload target is not a regular file: ${name}`);
  }
  if (st.size > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`Upload file exceeds size limit (10MB): ${name}`);
  }
  return real;
}

// ─── URL safety ──────────────────────────────────────────────────────

/** Only http/https may ever be navigated to or fetched. */
function isAllowedScheme(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Full URL safety gate for navigate / api-request values.
 * 1. must parse + be http(s) (file:, data:, ftp: etc. always rejected —
 *    even if validateUrl were bypassed);
 * 2. must be same-origin with the run target unless allowCrossOrigin;
 * 3. must pass ssrf.validateUrl (DNS + private-range checks).
 * Returns { ok: true } | { ok: false, reason, url }.
 */
export async function checkUrlSafety(urlString, opts = {}) {
  const url = String(urlString ?? '');
  if (!isAllowedScheme(url)) {
    let reason = 'invalid or disallowed URL scheme (only http/https are allowed)';
    try {
      reason = `disallowed URL scheme "${new URL(url).protocol}" (only http/https are allowed)`;
    } catch { /* keep generic */ }
    return { ok: false, reason, url };
  }

  if (opts.targetOrigin && opts.allowCrossOrigin !== true) {
    try {
      const origin = new URL(opts.targetOrigin).origin;
      if (new URL(url).origin !== origin) {
        return { ok: false, reason: `cross-origin URL (${new URL(url).origin}) — flow must declare allowCrossOrigin: true`, url };
      }
    } catch { /* unparseable target origin — skip same-origin check */ }
  }

  try {
    await validateUrl(url);
  } catch (err) {
    return { ok: false, reason: `ssrf validation failed: ${err.message}`, url };
  }
  return { ok: true, url };
}

// ─── variables ───────────────────────────────────────────────────────

/**
 * Replace ${VAR} placeholders from the flow variable scope first, then the
 * shared test-data store (data/testdata.json + SQA_TD_* env). Unknown
 * placeholders are left literal and reported via onEvent once per key.
 */
export function substituteStepValue(value, variables, onEvent) {
  if (typeof value !== 'string') return value;
  const scope = {};
  for (const [k, v] of Object.entries(variables || {})) {
    scope[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  const { value: resolved, unknown } = testData.substitute(value, { scope });
  for (const key of unknown) {
    onEvent?.(`warning: placeholder \${${key}} is not defined in the flow scope, test data store, or SQA_TD_* env — leaving literal`);
  }
  return resolved;
}

// ─── step dispatcher ─────────────────────────────────────────────────

/**
 * Resolve a step's selector through the fallback ladder.
 * Returns { locator, healedTo, ladder } — locator is the ORIGINAL selector's
 * locator when nothing on the ladder matched (so Playwright still produces
 * its familiar timeout error, classified as today).
 */
async function resolveForStep(page, selector, opts) {
  const detailed = await resolveLocatorDetailed(page, selector, {
    existenceTimeoutMs: opts.existenceTimeoutMs,
  });
  if (detailed.locator) {
    if (detailed.healed) {
      opts.onEvent?.(`selector self-healed: ${selector} → ${detailed.selector}`);
      return { locator: detailed.locator, healedTo: detailed.selector, ladder: detailed.ladder };
    }
    return { locator: detailed.locator, healedTo: undefined, ladder: detailed.ladder };
  }
  // Nothing found anywhere — fall back to the original selector so the
  // action itself produces the familiar locator-timeout error.
  return { locator: page.locator(selector), healedTo: undefined, ladder: detailed.ladder };
}

function annotateSelectorError(err, ladder) {
  if (ladder && ladder.length) err.selectorLadder = ladder;
  return err;
}

/**
 * Run a single flow step against a Playwright-like page.
 *
 * @param {object} step  — { action, selector, value, ... | api-request fields }
 * @param {object} page  — Playwright Page (or mock)
 * @param {object} [opts] — { onEvent, variables, targetOrigin, allowCrossOrigin, fetchImpl, timeoutMs }
 * @returns {Promise<{ healedTo?: string, skipped?: boolean, skipReason?: string, unsafeUrl?: string, status?: number }>}
 *   throws on assertion failure or step error
 */
export async function runStep(step, page, opts = {}) {
  const selector = step.selector;
  const timeout = step.timeoutMs || STEP_TIMEOUT_DEFAULT_MS;
  const variables = opts.variables || (opts.variables = {});
  const onEvent = opts.onEvent;
  const urlSafetyOpts = { targetOrigin: opts.targetOrigin, allowCrossOrigin: opts.allowCrossOrigin };

  switch (step.action) {
    case 'navigate': {
      const rawUrl = step.value || selector;
      if (!rawUrl) throw new Error('navigate requires a url (in value or selector)');
      const url = substituteStepValue(rawUrl, variables, onEvent);
      const safety = await checkUrlSafety(url, urlSafetyOpts);
      if (!safety.ok) {
        return { skipped: true, skipReason: safety.reason, unsafeUrl: url };
      }
      const response = await page.goto(url, { timeout });
      if (response && typeof response.status === 'function') page.lastStatus = response.status();
      return {};
    }
    case 'api-request': {
      const rawUrl = step.url || step.value;
      if (!rawUrl) throw new Error('api-request requires a url');
      const url = substituteStepValue(rawUrl, variables, onEvent);
      const safety = await checkUrlSafety(url, urlSafetyOpts);
      if (!safety.ok) {
        return { skipped: true, skipReason: safety.reason, unsafeUrl: url };
      }
      return runApiRequest(step, url, { variables, onEvent, fetchImpl: opts.fetchImpl, page });
    }
    case 'click': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.click({ timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'fill': {
      const value = substituteStepValue(step.value ?? '', variables, onEvent);
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.fill(value, { timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'select': {
      const value = substituteStepValue(step.value ?? '', variables, onEvent);
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.selectOption(value, { timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'check': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.check({ timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'uncheck': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.uncheck({ timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'hover': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.hover({ timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'focus': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.focus({ timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'press': {
      // step.value is the key to press (e.g. 'Enter')
      const value = substituteStepValue(step.value, variables, onEvent);
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.press(value, { timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'upload': {
      // step.value is a file path relative to data/uploads
      const value = substituteStepValue(step.value, variables, onEvent);
      const file = resolveUpload(value, opts.uploadDir);
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.setInputFiles(file, { timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'wait': {
      if (step.ms) {
        await page.waitForTimeout(step.ms);
      } else if (selector) {
        // Smart wait — wait for the resolved locator, not a bare sleep.
        const r = await resolveForStep(page, selector, opts);
        try { await r.locator.waitFor({ state: step.state || 'visible', timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
        return { healedTo: r.healedTo };
      } else {
        // Smart page readiness settle (replaces hardcoded 1000ms sleep)
        await waitForPageReady(page, { timeoutMs: timeout, onEvent });
      }
      return {};
    }
    case 'assertVisible': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.waitFor({ state: 'visible', timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'assertHidden': {
      const r = await resolveForStep(page, selector, opts);
      try { await r.locator.waitFor({ state: 'hidden', timeout }); } catch (err) { throw annotateSelectorError(err, r.ladder); }
      return { healedTo: r.healedTo };
    }
    case 'assertText': {
      const r = await resolveForStep(page, selector, opts);
      try {
        const text = await r.locator.textContent({ timeout });
        if (step.equals != null && text !== step.equals) {
          throw new Error(`assertText failed: expected "${step.equals}" but got "${text}"`);
        }
        if (step.contains != null && !String(text).includes(step.contains)) {
          throw new Error(`assertText failed: text "${text}" does not contain "${step.contains}"`);
        }
      } catch (err) {
        throw annotateSelectorError(err, r.ladder);
      }
      return { healedTo: r.healedTo };
    }
    case 'assertUrl': {
      const currentUrl = page.url();
      if (step.url && currentUrl !== step.url) {
        throw new Error(`assertUrl failed: expected "${step.url}" but got "${currentUrl}"`);
      }
      if (step.urlMatches) {
        const re = new RegExp(step.urlMatches);
        if (!re.test(currentUrl)) {
          throw new Error(`assertUrl failed: "${currentUrl}" does not match /${step.urlMatches}/`);
        }
      }
      if (step.urlContains && !currentUrl.includes(step.urlContains)) {
        throw new Error(`assertUrl failed: "${currentUrl}" does not contain "${step.urlContains}"`);
      }
      return {};
    }
    case 'assertStatus': {
      // status assertion requires capturing the navigation response — caller
      // should wire up a response listener. For now, throw if page.lastStatus
      // doesn't match (mock pages can set this; api-request steps set it too).
      const lastStatus = page.lastStatus;
      if (lastStatus == null) {
        throw new Error('assertStatus requires page.lastStatus to be tracked — not supported in this context');
      }
      if (lastStatus !== step.status) {
        throw new Error(`assertStatus failed: expected ${step.status} but got ${lastStatus}`);
      }
      return {};
    }
    default: {
      throw new Error(`Unknown flow step action: ${step.action}`);
    }
  }
}

// ─── hybrid API steps ────────────────────────────────────────────────

/** Walk a dot-path like `data.items.0.id` through a parsed JSON body. */
export function readJsonPath(body, dotPath) {
  if (body == null || !dotPath) return undefined;
  let cur = body;
  for (const part of String(dotPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

async function runApiRequest(step, url, { variables, onEvent, fetchImpl, page }) {
  const fetchFn = fetchImpl || safeFetch;
  if (!fetchFn) throw new Error('api-request requires fetch (safeFetch or ctx.options.fetch)');

  const method = String(step.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(step.headers || {})) {
    headers[k] = substituteStepValue(String(v), variables, onEvent);
  }

  let body;
  if (step.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof step.body === 'string'
      ? substituteStepValue(step.body, variables, onEvent)
      : substituteStepValue(JSON.stringify(step.body), variables, onEvent);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const timeoutMs = step.timeoutMs || API_TIMEOUT_DEFAULT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('api-request timeout')), timeoutMs);

  let response;
  try {
    response = await fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctrl.signal });
  } catch (err) {
    throw new Error(`api-request ${method} ${url} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (page) page.lastStatus = status;

  // Parse body — JSON when possible, text otherwise.
  let parsedBody;
  let textBody;
  try {
    textBody = await response.text();
    try { parsedBody = JSON.parse(textBody); } catch { parsedBody = undefined; }
  } catch { /* body read failed — leave undefined */ }

  if (step.expectStatus != null && status !== step.expectStatus) {
    throw new Error(`api-request expected status ${step.expectStatus} but got ${status} for ${url}`);
  }

  let valueAtPath;
  if (step.expectJsonPath) {
    if (parsedBody === undefined) {
      throw new Error(`api-request: expectJsonPath "${step.expectJsonPath}" could not be checked — response is not valid JSON`);
    }
    valueAtPath = readJsonPath(parsedBody, step.expectJsonPath);
    if (valueAtPath === undefined) {
      throw new Error(`api-request: expectJsonPath "${step.expectJsonPath}" not found in response body`);
    }
  }

  if (step.saveAsVar) {
    const saved = valueAtPath !== undefined
      ? valueAtPath
      : (parsedBody !== undefined ? parsedBody : textBody);
    variables[step.saveAsVar] = typeof saved === 'string' ? saved : JSON.stringify(saved);
    onEvent?.(`api-request saved response value into variable \${${step.saveAsVar}}`);
  }

  return { status };
}

// ─── failure evidence ────────────────────────────────────────────────

function slugify(str) {
  return String(str || 'flow').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
}

/**
 * Capture a screenshot of the failed flow state, following visual.js's
 * `{runId}_{slug}_..._{hash}.png` naming pattern. Returns the filename or
 * null when capture isn't possible (no dir/runId configured, mock pages).
 */
export async function captureFailureScreenshot(page, { screenshotsDir, runId, flow, stepIndex }) {
  if (!screenshotsDir || !runId || typeof page.screenshot !== 'function') return null;
  try {
    const buffer = await page.screenshot({ type: 'png' });
    const slug = String(flow?.startUrl || flow?.name || 'flow').replace(/[^a-zA-Z0-9]/g, '_').slice(-50);
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const filename = `${runId}_${slug}_${slugify(flow?.name)}_step${stepIndex ?? 'x'}_failure_${hash}.png`;
    await fs.mkdir(screenshotsDir, { recursive: true });
    await fs.writeFile(path.join(screenshotsDir, filename), buffer);
    return filename;
  } catch {
    return null;
  }
}

// ─── flow runner with retry ──────────────────────────────────────────

/**
 * Run a single flow with retry policy. Returns
 *   { ok, attempts, lastError, skippedSteps: [{index, action, reason, unsafeUrl}],
 *     evidence: { screenshot?, ladder?, stepIndex? } }
 *
 * On step failure, retries from step 0 (not from the failing step) —
 * this matches typical E2E test behavior and catches flakiness from
 * earlier setup steps.
 */
export async function runFlow(flow, page, options = {}) {
  const retry = flow.retry || { maxAttempts: 2, backoffMs: 500 };
  const maxAttempts = retry.maxAttempts || 2;
  const backoffMs = retry.backoffMs || 500;
  let lastError;
  let lastLadder = null;
  let lastFailedStepIndex = null;
  const skippedSteps = [];

  const stepOpts = {
    onEvent: options.onEvent,
    variables: options.variables || {},
    targetOrigin: options.targetOrigin,
    allowCrossOrigin: options.allowCrossOrigin === true || flow.allowCrossOrigin === true,
    fetchImpl: options.fetchImpl,
    existenceTimeoutMs: options.existenceTimeoutMs,
  };

  if (typeof page.on === 'function') {
    page.on('response', response => {
      try {
        if (response.request?.().isNavigationRequest?.()) page.lastStatus = response.status();
      } catch {}
    });
  }

  // The initial goto is a navigation too — gate it behind the same safety checks.
  const startUrl = substituteStepValue(flow.startUrl, stepOpts.variables, options.onEvent);
  const startSafety = await checkUrlSafety(startUrl, {
    targetOrigin: stepOpts.targetOrigin,
    allowCrossOrigin: stepOpts.allowCrossOrigin,
  });
  if (!startSafety.ok) {
    return {
      ok: false,
      attempts: 0,
      lastError: null,
      skippedSteps: [],
      unsafeStart: { url: startUrl, reason: startSafety.reason },
      evidence: {},
    };
  }

  const steps = flow.steps || [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Start at the flow's startUrl
      const response = await page.goto(startUrl, { timeout: options.pageTimeoutMs || 30000 });
      if (response && typeof response.status === 'function') page.lastStatus = response.status();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        let result;
        try {
          result = await runStep(step, page, stepOpts);
        } catch (err) {
          err.__stepIndex = i;
          throw err;
        }
        if (result?.skipped) {
          skippedSteps.push({
            index: i,
            action: step.action,
            reason: result.skipReason,
            unsafeUrl: result.unsafeUrl,
          });
        }
      }
      return {
        ok: true,
        attempts: attempt,
        lastError: null,
        skippedSteps,
        evidence: {},
      };
    } catch (err) {
      lastError = err;
      if (err?.selectorLadder) lastLadder = err.selectorLadder;
      if (lastFailedStepIndex == null) lastFailedStepIndex = err.__stepIndex ?? null;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  // Failure evidence — screenshot of the final failed state.
  const screenshot = await captureFailureScreenshot(page, {
    screenshotsDir: options.screenshotsDir,
    runId: options.runId,
    flow,
    stepIndex: lastFailedStepIndex,
  });

  return {
    ok: false,
    attempts: maxAttempts,
    lastError,
    skippedSteps,
    evidence: {
      ...(screenshot ? { screenshot } : {}),
      ...(lastLadder ? { ladder: lastLadder } : {}),
      ...(lastFailedStepIndex != null ? { stepIndex: lastFailedStepIndex } : {}),
    },
  };
}

// ─── main executor ───────────────────────────────────────────────────

/**
 * Main executor — runs every flow in plan.flows[].
 *
 * Requires ctx.context (Playwright BrowserContext). If absent, the executor
 * returns 0 findings with a warning so tests can verify the no-op path.
 */
export default async function e2eExecutor(ctx) {
  const flows = ctx.plan?.flows || [];

  if (!ctx.context) {
    ctx.onEvent?.('e2e skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const findings = [];
  const stats = { ran: 0, passed: 0, failed: 0, skipped: 0, unsafeSteps: 0 };
  const targetOrigin = (() => {
    try { return ctx.plan?.targetUrl ? new URL(ctx.plan.targetUrl).origin : undefined; } catch { return undefined; }
  })();

  ctx.onEvent?.(`Running ${flows.length} E2E flows`);

  for (const flow of flows) {
    if (ctx.signal?.aborted) {
      stats.skipped++;
      continue;
    }

    // Pick a viewport for this flow if specified
    const viewport = flow.viewport || ctx.plan.viewports?.[0] || { width: 1280, height: 720 };

    const page = await ctx.context.newPage();
    // Audit L-1: BrowserContext.newPage() takes no viewport argument — the
    // flow's viewport was silently ignored and every flow ran at the
    // context default. Set it explicitly after the page opens.
    if (viewport && typeof page.setViewportSize === 'function') {
      await page.setViewportSize({ width: viewport.width, height: viewport.height }).catch(() => {});
    }

    try {
      const result = await runFlow(flow, page, {
        pageTimeoutMs: 30000,
        screenshotsDir: ctx.screenshotsDir,
        runId: ctx.runId,
        targetOrigin,
        allowCrossOrigin: flow.allowCrossOrigin === true,
        onEvent: ctx.onEvent,
        fetchImpl: ctx.options?.fetch,
      });

      // Unsafe start URL — the whole flow was refused before running.
      if (result.unsafeStart) {
        stats.skipped++;
        stats.unsafeSteps++;
        ctx.onEvent?.(`Refused unsafe URL in flow "${flow.name}": ${result.unsafeStart.url} (${result.unsafeStart.reason})`);
        findings.push(ctx.createFinding({
          title: `E2E flow blocked: unsafe start URL in ${flow.name}`,
          severity: 'high',
          confidence: 'confirmed',
          category: 'security',
          findingType: 'warning',
          origin: 'first-party',
          ruleId: 'e2e-unsafe-url',
          pageUrl: result.unsafeStart.url,
          description: `Flow "${flow.name}" was not run: its start URL was rejected by the URL safety gate (${result.unsafeStart.reason}). Only http(s) URLs same-origin with the run target (or declared allowCrossOrigin flows) may be navigated.`,
          evidence: `URL: ${result.unsafeStart.url}\nReason: ${result.unsafeStart.reason}`,
          suggestedFix: 'Point the flow at the run target origin, or declare allowCrossOrigin: true on the flow if the external navigation is intentional.',
        }));
        continue;
      }

      // Unsafe skipped steps — refused mid-flow.
      for (const skipped of result.skippedSteps || []) {
        if (!skipped.unsafeUrl) continue;
        stats.unsafeSteps++;
        ctx.onEvent?.(`Refused unsafe URL in flow "${flow.name}" step ${skipped.index}: ${skipped.unsafeUrl} (${skipped.reason})`);
        findings.push(ctx.createFinding({
          title: `E2E step blocked: unsafe URL in ${flow.name} (step ${skipped.index + 1})`,
          severity: 'high',
          confidence: 'confirmed',
          category: 'security',
          findingType: 'warning',
          origin: 'first-party',
          ruleId: 'e2e-unsafe-url',
          pageUrl: skipped.unsafeUrl,
          description: `Step ${skipped.index + 1} (${skipped.action}) of flow "${flow.name}" was skipped: its URL was rejected by the URL safety gate (${skipped.reason}).`,
          evidence: `URL: ${skipped.unsafeUrl}\nReason: ${skipped.reason}\nStep: ${skipped.action}`,
          suggestedFix: 'Use an http(s) URL on the run target origin, or declare allowCrossOrigin: true on the flow if the external navigation is intentional.',
        }));
      }

      if (result.ok) {
        stats.passed++;
        stats.ran++;
      } else {
        stats.failed++;
        stats.ran++;
        const errMsg = result.lastError?.message || String(result.lastError);
        // A locator timeout means the flow's element never appeared — the test
        // script itself couldn't run (selector drift, bot wall), which is a
        // test-authoring issue, not a confirmed site bug.
        const isSelectorTimeout = /Timeout \d+ms exceeded/i.test(errMsg) && /waiting for locator/i.test(errMsg);
        const ladder = result.evidence?.ladder;
        const ladderText = ladder
          ? `Selector fallback ladder tried:\n${ladder.map(l => `  ${l.found ? '[found] ' : '[miss] '}${l.candidate}`).join('\n')}`
          : null;
        const screenshotFile = result.evidence?.screenshot;
        const evidenceParts = [
          `Start URL: ${flow.startUrl}`,
          `Steps: ${(flow.steps || []).length}`,
          `Last error: ${result.lastError?.stack || errMsg}`,
        ];
        if (ladderText) evidenceParts.push(ladderText);
        if (screenshotFile) evidenceParts.push(`Failure screenshot: ${screenshotFile}`);

        if (isSelectorTimeout) {
          findings.push(ctx.createFinding({
            title: `E2E flow could not run: ${flow.name}`,
            severity: 'medium',
            confidence: 'suspected',
            category: 'network',
            findingType: 'environmental',
            origin: 'first-party',
            ruleId: 'e2e-flow-selector-timeout',
            pageUrl: flow.startUrl,
            description: `Flow "${flow.name}" stopped after ${result.attempts} attempt(s): ${errMsg.split('\n')[0]}. The flow's selector didn't match anything on the page in time — usually selector drift or automation blocking, not a site bug.`,
            evidence: evidenceParts.join('\n'),
            ...(screenshotFile ? { screenshot: path.join(ctx.screenshotsDir || '', screenshotFile) } : {}),
            reproSteps: [
              `Navigate to ${flow.startUrl}`,
              ...(flow.steps || []).map((s, i) => `${i + 1}. ${s.action} ${s.selector || s.value || ''}`.trim()),
            ],
            suggestedFix: 'Update the flow selector to match the current page markup, or re-run with a corrected plan. If the element genuinely disappeared from the page, treat it as a regression.',
          }));
        } else {
          findings.push(ctx.createFinding({
            title: `E2E flow failed: ${flow.name}`,
            severity: 'high',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'e2e-flow-failure',
            pageUrl: flow.startUrl,
            description: `Flow "${flow.name}" failed after ${result.attempts} attempt(s): ${errMsg}`,
            evidence: evidenceParts.join('\n'),
            ...(screenshotFile ? { screenshot: path.join(ctx.screenshotsDir || '', screenshotFile) } : {}),
            reproSteps: [
              `Navigate to ${flow.startUrl}`,
              ...(flow.steps || []).map((s, i) => `${i + 1}. ${s.action} ${s.selector || s.value || ''}`.trim()),
            ],
            suggestedFix: 'Investigate the failing step — likely a selector change, race condition, or genuine regression.',
          }));
        }
      }
    } catch (err) {
      // runFlow catches step errors internally; reaching here means the flow
      // harness itself broke. Record it so one bad flow can't kill the run.
      stats.failed++;
      stats.ran++;
      findings.push(ctx.createFinding({
        title: `E2E flow failed: ${flow.name}`,
        severity: 'high',
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        origin: 'first-party',
        ruleId: 'e2e-flow-failure',
        pageUrl: flow.startUrl,
        description: `Flow "${flow.name}" could not be executed: ${err.message}`,
        evidence: String(err.stack || err.message),
        suggestedFix: 'Investigate the failing step — likely a selector change, race condition, or genuine regression.',
      }));
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`e2e complete: ${stats.passed}/${stats.ran} passed, ${stats.failed} failed, ${stats.unsafeSteps} unsafe URL(s) refused`);
  return { findings, stats };
}
