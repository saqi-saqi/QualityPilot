/**
 * mcp/reporting.js — build structured, agent-facing reports from run objects,
 * enforcing correctness invariants and token-lean payload discipline (WS4.3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateReport, ALWAYS_MEASURED_FIELDS } from '../reporting/invariants.js';
import { isCoverageFailure, isUnauthenticatedProbe } from '../services/scoring.js';
import { redactFinding, sanitizeUrl } from './redact.js';

export const DEFAULT_MCP_TOKEN_BUDGET = 1800;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / CHARS_PER_TOKEN);
}

/**
 * Resolve artifact directory for bulky MCP responses.
 * Uses TESTIGATOR_MCP_ARTIFACTS_DIR or SQA_MCP_ARTIFACTS_DIR if set,
 * otherwise <cwd>/.testigator/artifacts.
 */
export function resolveMcpArtifactsDir() {
  return path.resolve(
    process.env.TESTIGATOR_MCP_ARTIFACTS_DIR
      || process.env.SQA_MCP_ARTIFACTS_DIR
      || path.join(process.cwd(), '.testigator', 'artifacts')
  );
}

/**
 * No raw 0 may appear for an "always measured" metric without an explicit
 * unmeasured flag.
 */
export function normalizeSilentZeros(findings) {
  for (const f of findings) {
    const metrics = f?.metrics;
    if (!metrics || typeof metrics !== 'object') continue;
    for (const field of ALWAYS_MEASURED_FIELDS) {
      if (metrics[field] === 0) {
        metrics[field] = null;
        if (!Array.isArray(metrics._unmeasured)) metrics._unmeasured = [];
        if (!metrics._unmeasured.includes(field)) metrics._unmeasured.push(field);
        metrics.measured = { ...(metrics.measured || {}), [field]: false };
      }
    }
  }
  return findings;
}

/**
 * Write the complete redacted JSON report to `.qualitypilot/artifacts/<id>/report.json`
 * and return the disk path so the agent can inspect full details on demand.
 */
export function persistMcpArtifact(runId, fullReport) {
  const safeId = String(runId || `mcp_${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = path.join(resolveMcpArtifactsDir(), safeId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'report.json');
  fs.writeFileSync(filePath, JSON.stringify(fullReport, null, 2) + '\n', 'utf8');
  return filePath;
}

function compactFindingForWire(f) {
  return {
    rule: f.rule,
    severity: f.severity,
    url: f.url,
    ...(f.selector ? { selector: String(f.selector).slice(0, 80) } : {}),
    ...(f.title ? { title: String(f.title).slice(0, 120) } : {}),
    ...(f.suggestedFix ? { suggestedFix: String(f.suggestedFix).slice(0, 160) } : {}),
  };
}

/**
 * Enforce the MCP token budget (default 1,800 tokens / ~7,200 bytes) on any
 * wire response. When oversized, writes the complete redacted payload to disk
 * under `.qualitypilot/artifacts/<id>/report.json` and returns a compact
 * verdict carrying the top findings plus `artifactPath` + `truncated`.
 */
export function enforceMcpPayloadBudget(payload, {
  runId = null,
  tokenBudget = Number(process.env.SQA_MCP_TOKEN_BUDGET) || DEFAULT_MCP_TOKEN_BUDGET,
  alwaysPersistFull = false,
} = {}) {
  const serialized = JSON.stringify(payload);
  const tokens = estimateTokens(serialized);

  if (!alwaysPersistFull && tokens <= tokenBudget) {
    return payload;
  }

  const artifactPath = persistMcpArtifact(runId || payload.runId || `mcp_${Date.now()}`, payload);
  if (tokens <= tokenBudget) {
    return { ...payload, artifactPath };
  }

  // Build compact wire view preserving verdict, counts, coverage, and as many
  // high-priority findings as fit comfortably below tokenBudget.
  const maxBytes = tokenBudget * CHARS_PER_TOKEN;
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sortBySev = (arr = []) => [...arr].sort((a, b) => (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5));

  const confirmedAll = sortBySev(payload.confirmed || []).map(compactFindingForWire);
  const suspectedAll = sortBySev(payload.suspected || []).map(compactFindingForWire);
  const otherAll = sortBySev(payload.other || []).map(compactFindingForWire);

  const wire = {
    ...(payload.schemaVersion != null ? { schemaVersion: payload.schemaVersion } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.runId ? { runId: payload.runId } : {}),
    ...(payload.pass !== undefined ? { pass: payload.pass } : {}),
    url: payload.url,
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.score !== undefined ? { score: payload.score } : {}),
    ...(payload.summary ? { summary: payload.summary } : {}),
    ...(payload.coverage ? { coverage: payload.coverage } : {}),
    ...(payload.confirmedCount !== undefined ? { confirmedCount: payload.confirmedCount } : {}),
    ...(payload.suspectedCount !== undefined ? { suspectedCount: payload.suspectedCount } : {}),
    ...(payload.otherCount !== undefined ? { otherCount: payload.otherCount } : {}),
    confirmed: [],
    suspected: [],
    other: [],
    coverageFailures: (payload.coverageFailures || []).slice(0, 5),
    artifactPath,
    truncated: true,
    note: `Full findings and evidence written to ${artifactPath}. Showing highest-severity subset within MCP token budget.`,
  };

  const tryPush = (targetArr, item) => {
    targetArr.push(item);
    if (Buffer.byteLength(JSON.stringify(wire), 'utf8') > maxBytes) {
      targetArr.pop();
      return false;
    }
    return true;
  };

  for (const item of confirmedAll) {
    if (!tryPush(wire.confirmed, item)) break;
  }
  for (const item of suspectedAll) {
    if (!tryPush(wire.suspected, item)) break;
  }
  for (const item of otherAll) {
    if (!tryPush(wire.other, item)) break;
  }

  wire.truncatedCounts = {
    confirmedShown: wire.confirmed.length,
    confirmedTotal: confirmedAll.length,
    suspectedShown: wire.suspected.length,
    suspectedTotal: suspectedAll.length,
    otherShown: wire.other.length,
    otherTotal: otherAll.length,
  };

  return wire;
}

/**
 * Build a structured report from a run object.
 *
 * Internally validates against `validateReport()` using the unified `findings`
 * array, then returns a single-copy wire object (no duplicate `findings` +
 * `allFindings` multiplication) — and persists to `.qualitypilot/artifacts/`
 * whenever `verbosity === 'full'` or payload exceeds the MCP token budget.
 */
export function buildMcpReport(run, { verbosity = 'summary' } = {}) {
  if (!run || typeof run !== 'object') {
    return { report: null, validation: { valid: false, errors: ['Run object is null or not an object'] } };
  }

  const findings = normalizeSilentZeros(
    (Array.isArray(run.findings) ? run.findings : []).map(f => structuredCloneSafe(f))
  );

  const confirmed = findings.filter(f =>
    !isCoverageFailure(f) && !isUnauthenticatedProbe(f) &&
    f.confidence === 'confirmed' && (f.findingType === 'bug' || !f.findingType)
  );
  const suspected = findings.filter(f =>
    !isCoverageFailure(f) && isUnauthenticatedProbe(f)
  );
  const coverageFailures = findings.filter(isCoverageFailure);
  const other = findings.filter(f =>
    !confirmed.includes(f) && !suspected.includes(f) && !coverageFailures.includes(f)
  );

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of confirmed) {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++;
  }

  const coverage = run.coverage && typeof run.coverage === 'object'
    ? { ...run.coverage }
    : deriveCoverage(run, coverageFailures.length);

  const wireConfirmed = confirmed.map(f => redactFinding(f, verbosity));
  const wireSuspected = suspected.map(f => redactFinding(f, verbosity));
  const wireOther = other.map(f => redactFinding(f, verbosity));
  const wireCovFailures = coverageFailures.map(f => ({
    rule: f.ruleId || 'page-load-failure',
    url: sanitizeUrl(f.pageUrl || f.url || ''),
    reason: (f.description || f.evidence || 'page failed to load').slice(0, 300),
    blockedExecutors: f.blockedExecutors || null,
  }));

  const validationTarget = {
    schemaVersion: 1,
    source: 'testigator-mcp',
    runId: run.runId || null,
    url: sanitizeUrl(run.url || ''),
    status: run.status || 'unknown',
    score: typeof run.score === 'number' ? run.score : null,
    summary: {
      totalFindingsShown: confirmed.length + suspected.length + coverageFailures.length,
      confirmedBugs: confirmed.length,
      unauthenticatedProbes: suspected.length,
      coverageFailures: coverageFailures.length,
      bySeverity,
    },
    coverage,
    confirmed: wireConfirmed,
    suspected: wireSuspected,
    otherCount: wireOther.length,
    other: wireOther,
    coverageFailures: wireCovFailures,
    findings: [...confirmed, ...suspected, ...coverageFailures, ...other].map(f => redactFinding(f, verbosity)),
  };

  const validation = validateReport(validationTarget, { throwOnError: false });
  if (!validation.valid) {
    return { report: null, validation };
  }

  // Wire response omits duplicate `findings` array (saved in artifact if bulky).
  const fullForArtifact = {
    schemaVersion: 1,
    source: 'testigator-mcp',
    runId: run.runId || null,
    url: sanitizeUrl(run.url || ''),
    status: run.status || 'unknown',
    score: typeof run.score === 'number' ? run.score : null,
    summary: validationTarget.summary,
    coverage,
    confirmed: wireConfirmed,
    suspected: wireSuspected,
    otherCount: wireOther.length,
    other: wireOther,
    coverageFailures: wireCovFailures,
    ...(verbosity === 'full' && run.summary ? { runSummary: run.summary } : {}),
  };

  const wireReport = enforceMcpPayloadBudget(fullForArtifact, {
    runId: run.runId,
    alwaysPersistFull: verbosity === 'full',
  });

  return { report: wireReport, validation };
}

function deriveCoverage(run, coverageFailureCount) {
  const pagesAttempted = Array.isArray(run.pages)
    ? run.pages.length
    : (run.options?.maxPages || 1);
  const pagesScanned = Math.max(0, pagesAttempted - coverageFailureCount);
  return {
    pagesAttempted,
    pagesScanned,
    coverageRatio: pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0,
  };
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}
