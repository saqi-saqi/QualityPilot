#!/usr/bin/env node
/**
 * benchmark/run-recall-benchmark.mjs — Juice Shop recall harness.
 *
 * Measures the recall of a full-surface `testigator check` scan against a
 * curated ground truth of verifiable defect expectations on OWASP Juice Shop
 * (benchmark/groundtruth-juiceshop.json), plus must-not-find assertions that
 * guard against known false-positive modes.
 *
 * Design invariants:
 *   • Drift-proof: every `expected` entry carries a `liveCheck` that the
 *     harness re-verifies against the LIVE target before scoring. If the
 *     expectation no longer holds on the target (e.g. the app added CSP),
 *     the entry is excluded from the denominator and reported — it can never
 *     silently deflate or inflate recall.
 *   • Default surface only: the scan is exactly what `testigator check`
 *     runs (matrix path, inferred plan, default executor list). No special
 *     benchmark mode — recall is measured on the product a user gets.
 *   • Deterministic denominator: only `expected` entries score. Crawl-depth-
 *     dependent detectors are reported as observational context, never scored.
 *
 * Usage:
 *   node benchmark/run-recall-benchmark.mjs [--base-url http://localhost:3000]
 *        [--max-pages 12] [--max-depth 2] [--timeout 900000]
 *        [--min-recall 1.0] [--skip-scan]   # score an existing run JSON instead
 *
 * Exit codes: 0 ok · 1 below --min-recall · 2 target/setup failure
 *             · 3 scan output unparseable
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractJsonDocument as extractJson } from '../src/utils/jsonDocument.js';

export { extractJson };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = 'http://localhost:3000';
// Documented Juice Shop smoke instance (see project memory): standalone zip.
const DEFAULT_JUICE_DIR = String(process.env.JUICE_SHOP_DIR || 'C:\\Users\\user\\AppData\\Local\\Temp\\juice-shop-smoke\\app\\juice-shop_20.4.0-SNAPSHOT');

// ─── tiny CLI arg parse ────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    maxPages: 12,
    maxDepth: 2,
    timeout: 900000,
    minRecall: null,
    skipScan: null, // path to a saved run JSON — score it without scanning
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--max-pages') out.maxPages = Number(argv[++i]);
    else if (a === '--max-depth') out.maxDepth = Number(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--min-recall') out.minRecall = Number(argv[++i]);
    else if (a === '--skip-scan') out.skipScan = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// ─── JSON extraction from the CLI's mixed stdout ──────────────────────
// The scanner moved to src/utils/jsonDocument.js (shared with the Phase 6
// `--baseline` loader); re-exported above so harness tests keep their import.

// ─── live expectation verification ────────────────────────────────────
async function verifyLiveCheck(check, baseUrl) {
  const root = baseUrl.replace(/\/$/, '');
  const res = await fetch(baseUrl, { redirect: 'manual' });
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
  if (check.type === 'header-absent') {
    return { holds: headers[check.header] == null || String(headers[check.header]).trim() === '' };
  }
  if (check.type === 'scheme-http') {
    return { holds: new URL(baseUrl).protocol === 'http:' };
  }
  if (check.type === 'sqli-login') {
    // The documented tautology bypass: benign email → 401, payload → 200+token.
    // Side effect: solves the Juice Shop login challenge (ctf.key must exist).
    const res = await fetch(root + '/rest/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: "' OR 1=1--", password: 'x' }),
    });
    return { holds: res.status === 200 };
  }
  if (check.type === 'sqli-error') {
    const res = await fetch(root + '/rest/products/search?q=' + encodeURIComponent("')"));
    return { holds: res.status === 500 };
  }
  if (check.type === 'admin-anon') {
    // Verified live 2026-11-17: the admin-namespaced config endpoint answers
    // 200 anonymously on the pinned target.
    const res = await fetch(root + '/rest/admin/application-configuration');
    return { holds: res.status === 200 };
  }
  if (check.type === 'dom-xss-search') {
    // Browser-based: the sink is client-side rendering (no fetch can verify it).
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const payload = '<iframe src="javascript:qp_dom_xss_probe"></iframe>';
      await page.goto(root + '/#/search?q=' + encodeURIComponent(payload), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const reflected = await page.evaluate(
        (marker) => document.documentElement.innerHTML.includes(marker),
        'qp_dom_xss_probe',
      );
      return { holds: reflected === true };
    } finally {
      await browser.close();
    }
  }
  throw new Error(`Unknown liveCheck type: ${check.type}`);
}

// ─── target bootstrap ─────────────────────────────────────────────────
async function isUp(baseUrl) {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(4000) });
    return res.status > 0;
  } catch { return false; }
}

async function ensureTarget(baseUrl, onEvent) {
  if (await isUp(baseUrl)) return { bootedHere: false };
  const juiceDir = DEFAULT_JUICE_DIR;
  const entry = existsSync(path.join(juiceDir, 'build', 'app.js'))
    ? path.join(juiceDir, 'build', 'app.js')
    : null;
  if (!entry) {
    throw new Error(`Target ${baseUrl} is down and no Juice Shop instance found at ${juiceDir} — start the target manually or set JUICE_SHOP_DIR`);
  }
  onEvent(`Target down — booting Juice Shop from ${juiceDir}`);
  const child = spawn(process.execPath, [entry], {
    cwd: juiceDir,
    stdio: 'ignore',
    detached: false,
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isUp(baseUrl)) return { bootedHere: true, child };
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error('Juice Shop did not come up within 60s');
}

// ─── scan ─────────────────────────────────────────────────────────────
function runScan({ baseUrl, maxPages, maxDepth, timeout }) {
  const cliPath = path.join(REPO_ROOT, 'src', 'cli', 'check.js');
  const args = [
    cliPath, baseUrl,
    '--max-pages', String(maxPages),
    '--max-depth', String(maxDepth),
    '--timeout', String(timeout),
    '--format', 'json',
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeout + 120000, // CLI deadline + slack for teardown
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SQA_ALLOW_PRIVATE: 'true', ALLOW_PRIVATE_HOSTS: 'true' },
  });
  const code = res.status;
  // CLI exit codes: 0 pass · 1 gate · 64 usage · 70 scan failure/timeout.
  // Exit 1 (gate) still carries a completed scan — score it.
  if (code !== 0 && code !== 1) {
    throw new Error(`check CLI exited ${code}: ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  }
  return extractJson(String(res.stdout || ''));
}

// ─── scoring ──────────────────────────────────────────────────────────
export function scoreReport({ report, groundtruth, liveChecks }) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const byRule = new Map(); // ruleId → [findings]
  for (const f of findings) {
    const rid = String(f.ruleId || f.title || 'unknown');
    if (!byRule.has(rid)) byRule.set(rid, []);
    byRule.get(rid).push(f);
  }

  // Expected entries whose liveCheck no longer holds are excluded, not failed.
  const scored = [];
  const stale = [];
  for (const exp of groundtruth.expected) {
    const check = liveChecks[exp.id];
    if (check && check.holds === false) stale.push(exp);
    else scored.push(exp);
  }

  const detected = [];
  const missed = [];
  for (const exp of scored) {
    (byRule.has(exp.ruleId) ? detected : missed).push(exp);
  }

  const fpHits = groundtruth.mustNotFind.filter((n) => byRule.has(n.ruleId));

  const observational = [];
  for (const [rid, fs] of byRule) {
    if (groundtruth.expected.some((e) => e.ruleId === rid)) continue;
    if (groundtruth.mustNotFind.some((n) => n.ruleId === rid)) continue;
    observational.push({ ruleId: rid, count: fs.length, severity: fs[0]?.severity, detectorSample: fs[0]?.category });
  }
  observational.sort((a, b) => b.count - a.count);

  const recall = scored.length ? detected.length / scored.length : null;
  return { scored, stale, detected, missed, fpHits, observational, recall, findingsTotal: findings.length, byRuleSize: byRule.size };
}

// ─── report rendering ─────────────────────────────────────────────────
/**
 * Tooling provenance recorded in every receipt (audit M-8): the version and
 * the exact commit the scan ran at. Unknown values stay null — never guessed.
 */
function toolingProvenance() {
  const out = { version: null, commit: null, dirty: null };
  try {
    out.version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  } catch { /* package.json unreadable — leave null */ }
  try {
    const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (rev.status === 0) out.commit = rev.stdout.trim();
    const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (status.status === 0) out.dirty = status.stdout.trim().length > 0;
  } catch { /* git unavailable — keep nulls */ }
  return out;
}

function renderMarkdown({ meta, result, report, elapsedMs, scored, detected, missed, stale, fpHits, observational }) {
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const lines = [];
  lines.push(`# Testigator recall benchmark — ${meta.target}`);
  lines.push('');
  lines.push(`- **Run:** ${report.runId} · status \`${report.status}\` · score ${report.score ?? '—'}`);
  // Audit M-8: a receipt must state the tooling it describes (version +
  // commit). Without it a receipt silently drifts from the code.
  if (meta.tooling) {
    const t = meta.tooling;
    const commit = t.commit ? t.commit.slice(0, 12) : 'not recorded';
    lines.push(`- **Tooling:** testigator@${t.version} · commit \`${commit}\`${t.dirty ? ' · dirty working tree' : ''}`);
  }
  lines.push(`- **Scan params:** max-pages ${meta.maxPages}, max-depth ${meta.maxDepth}, timeout ${meta.timeout}ms, wall time ${Math.round(elapsedMs / 1000)}s`);
  lines.push(`- **Findings (post-dedup):** ${result.findingsTotal} distinct rules: ${result.byRuleSize}`);
  lines.push('');
  lines.push(`## Recall: ${detected.length}/${scored.length} = **${pct(result.recall)}**`);
  lines.push('');
  lines.push('| # | ruleId | severity | detector | status |');
  lines.push('|---|--------|----------|----------|--------|');
  for (const exp of scored) {
    const ok = detected.includes(exp);
    lines.push(`| ${exp.id} | \`${exp.ruleId}\` | ${exp.severity} | ${exp.detector} | ${ok ? '✅ detected' : '❌ missed'} |`);
  }
  if (stale.length) {
    lines.push('');
    lines.push(`**Excluded (liveCheck no longer holds on target):** ${stale.map((s) => s.id).join(', ')}`);
  }
  lines.push('');
  lines.push(`## Must-not-find (false-positive guard): ${fpHits.length === 0 ? '✅ all clear' : '❌ VIOLATED'}`);
  if (fpHits.length) {
    for (const n of fpHits) lines.push(`- \`${n.ruleId}\` — ${n.rationale}`);
  }
  lines.push('');
  lines.push(`## Observational findings (not scored) — ${observational.length} distinct rules`);
  if (observational.length === 0) lines.push('- none');
  else {
    lines.push('');
    lines.push('| ruleId | count | severity |');
    lines.push('|--------|-------|----------|');
    for (const o of observational.slice(0, 30)) lines.push(`| \`${o.ruleId}\` | ${o.count} | ${o.severity ?? '—'} |`);
    if (observational.length > 30) lines.push(`| … ${observational.length - 30} more | | |`);
  }
  if (missed.length) {
    lines.push('');
    lines.push('## Missed expectations — triage notes');
    for (const m of missed) lines.push(`- **${m.id}** \`${m.ruleId}\`: ${m.rationale}`);
  }
  return lines.join('\n') + '\n';
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gtPath = path.join(REPO_ROOT, 'benchmark', 'groundtruth-juiceshop.json');
  const groundtruth = JSON.parse(readFileSync(gtPath, 'utf8'));
  const outDir = path.join(REPO_ROOT, 'benchmark', 'results');
  mkdirSync(outDir, { recursive: true });
  const events = [];

  // 1. Target up (boot if needed and documented instance exists).
  const onEvent = (m) => { events.push({ t: new Date().toISOString(), m }); console.log(`[harness] ${m}`); };
  const target = await ensureTarget(opts.baseUrl, onEvent);

  // 2. Verify expectations against the live target (drift guard).
  const liveChecks = {};
  for (const exp of groundtruth.expected) {
    try {
      liveChecks[exp.id] = await verifyLiveCheck(exp.liveCheck, opts.baseUrl);
    } catch (err) {
      onEvent(`liveCheck failed for ${exp.id}: ${err.message}`);
      liveChecks[exp.id] = { holds: true, error: err.message }; // don't exclude on probe flake; scan itself will miss it
    }
  }

  // 3. Scan (or load a saved run).
  const t0 = Date.now();
  let report;
  if (opts.skipScan) {
    report = extractJson(readFileSync(opts.skipScan, 'utf8'));
    onEvent(`scoring saved run from ${opts.skipScan}`);
  } else {
    onEvent(`running check CLI: ${opts.baseUrl} (pages ${opts.maxPages}, depth ${opts.maxDepth}, timeout ${opts.timeout}ms)`);
    report = runScan(opts);
  }
  const elapsedMs = Date.now() - t0;

  // 4. Score.
  if (report.status !== 'completed') {
    console.error(`[harness] scan did not complete: status=${report.status} runId=${report.runId}`);
    if (target.bootedHere && target.child) target.child.kill();
    process.exit(2);
  }
  const result = scoreReport({ report, groundtruth, liveChecks });

  // 5. Write artifacts.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const machine = {
    benchmark: 'juiceshop-recall',
    tooling: toolingProvenance(),
    groundtruth: path.basename(gtPath),
    run: { runId: report.runId, status: report.status, score: report.score, url: report.url },
    params: { ...opts, skipScan: undefined },
    wallTimeMs: elapsedMs,
    recall: result.recall,
    scoredCount: result.scored.length,
    detectedCount: result.detected.length,
    missed: result.missed.map((m) => ({ id: m.id, ruleId: m.ruleId, severity: m.severity })),
    staleExpectations: result.stale.map((s) => s.id),
    mustNotFindViolations: result.fpHits.map((n) => n.ruleId),
    observational: result.observational,
    findingsTotal: result.findingsTotal,
    events,
    finishedAt: new Date().toISOString(),
  };
  const jsonPath = path.join(outDir, `${stamp}-recall.json`);
  const mdPath = path.join(outDir, `${stamp}-recall.md`);
  writeFileSync(jsonPath, JSON.stringify(machine, null, 2) + '\n', 'utf8');
  writeFileSync(mdPath, renderMarkdown({
    meta: { ...groundtruth.meta, ...machine.params, tooling: machine.tooling }, result, report, elapsedMs,
    scored: result.scored, detected: result.detected, missed: result.missed,
    stale: result.stale, fpHits: result.fpHits, observational: result.observational,
  }), 'utf8');

  // 6. Console summary.
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(`Recall: ${result.detected.length}/${result.scored.length} = ${pct(result.recall)}`);
  console.log(`Must-not-find violations: ${result.fpHits.length}`);
  console.log(`Distinct rules reported: ${result.byRuleSize} (observational: ${result.observational.length})`);
  console.log(`Wall time: ${Math.round(elapsedMs / 1000)}s · run ${report.runId}`);
  for (const m of result.missed) console.log(`  MISSED ${m.id} ${m.ruleId} (${m.severity})`);
  for (const n of result.fpHits) console.log(`  FALSE-POSITIVE GUARD HIT: ${n.ruleId}`);
  console.log(`Artifacts: ${path.relative(REPO_ROOT, jsonPath)} · ${path.relative(REPO_ROOT, mdPath)}`);
  console.log('════════════════════════════════════════════');

  if (target.bootedHere && target.child) target.child.kill();
  if (opts.minRecall != null && (result.recall ?? 0) < opts.minRecall) process.exit(1);
}

// Run only when invoked directly (not on import) so the pure helpers above
// stay unit-testable: `node -e "import { extractJson } from …"` must not
// launch a real 15-minute scan.
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[harness] FAILED: ${err.message}`);
    process.exit(2);
  });
}
