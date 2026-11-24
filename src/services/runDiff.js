/**
 * services/runDiff.js — run-to-run comparison (regression triage).
 *
 * Compares the findings of two runs of the same site and classifies them:
 *   • newFindings         — present in run B, absent in run A (regressions)
 *   • resolvedFindings    — present in run A, gone in run B (fixes)
 *   • persistentFindings  — present in both (known issues)
 *
 * Findings are matched by `ruleId + pageUrl` first. When either part of that
 * identity is missing (some finding types — e.g. crawl errors — have no
 * stable rule/page pair), the normalized title is used as a fallback key.
 *
 * Pure code, no storage: callers pass run objects (from runStore / runManager)
 * and get a plain result object back.
 */

const SEV_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Normalize a finding title for fallback matching (case + whitespace). */
export function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a finding's page URL for identity matching (audit L-10).
 *
 * Run A and run B routinely record the same page slightly differently — a
 * trailing slash on the root, an explicit default port, host casing — and the
 * raw-string key turned those into a false "resolved + new" pair. URL
 * normalizes scheme/host casing and default ports itself; the path stays
 * case-sensitive; the FRAGMENT IS PRESERVED because hash-routed SPA pages
 * (`#/login` vs `#/register`) are distinct crawl targets.
 */
export function normalizePageUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    let out = url.toString();
    if (url.pathname === '/' && !url.search && !url.hash) out = out.replace(/\/$/, '');
    return out;
  } catch {
    return raw;
  }
}

/**
 * Identity key for a finding: ruleId + pageUrl when both are present,
 * otherwise the normalized title (prefixed so the two can never collide).
 * Returns null when the finding has no usable identity.
 */
export function findingKey(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const ruleId = typeof finding.ruleId === 'string' ? finding.ruleId.trim() : '';
  const pageUrl = normalizePageUrl(finding.pageUrl);
  if (ruleId && pageUrl) return `id:${ruleId}|${pageUrl}`;
  const title = normalizeTitle(finding.title);
  return title ? `title:${title}` : null;
}

/** Index a run's findings by identity key → list of findings sharing it. */
function indexFindings(run) {
  const byKey = new Map();
  for (const f of (run && Array.isArray(run.findings)) ? run.findings : []) {
    const key = findingKey(f);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  return byKey;
}

/**
 * Collapse a list of same-key findings into one representative entry:
 * the worst severity wins, occurrences are summed, pageUrls merged.
 */
function pickRepresentative(list) {
  const sorted = [...list].sort((a, b) =>
    (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
    (b.occurrences || 1) - (a.occurrences || 1));
  const rep = { ...sorted[0] };
  rep.occurrences = list.reduce((sum, f) => sum + (f.occurrences || 1), 0);
  const pages = new Set();
  for (const f of list) {
    for (const p of (f.affectedPages || [f.pageUrl].filter(Boolean) || [])) {
      if (p) pages.add(p);
    }
  }
  if (pages.size > 0) rep.affectedPages = [...pages];
  return rep;
}

function sortBySeverity(list) {
  return list.sort((a, b) =>
    (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
    String(a.title || '').localeCompare(String(b.title || '')));
}

/**
 * Diff two runs. runA is the baseline (older), runB the current run.
 *
 * @param {object} runA — baseline run ({ findings, score, runId })
 * @param {object} runB — comparison run
 * @returns {object} { newFindings, resolvedFindings, persistentFindings,
 *                     scoreDelta, summary }
 */
export function diffRuns(runA, runB) {
  const indexA = indexFindings(runA);
  const indexB = indexFindings(runB);

  const newFindings = [];
  const persistentFindings = [];

  for (const [key, listB] of indexB) {
    const repB = pickRepresentative(listB);
    if (indexA.has(key)) {
      const repA = pickRepresentative(indexA.get(key));
      const entry = { ...repB };
      if ((SEV_RANK[repB.severity] || 0) !== (SEV_RANK[repA.severity] || 0)) {
        entry.previousSeverity = repA.severity;
      }
      persistentFindings.push(entry);
    } else {
      newFindings.push(repB);
    }
  }

  const resolvedFindings = [];
  for (const [key, listA] of indexA) {
    if (!indexB.has(key)) resolvedFindings.push(pickRepresentative(listA));
  }

  sortBySeverity(newFindings);
  sortBySeverity(resolvedFindings);
  sortBySeverity(persistentFindings);

  const scoreDelta = (runA?.score != null && runB?.score != null)
    ? Math.round((Number(runB.score) - Number(runA.score)) * 10) / 10
    : null;

  let summary = `${newFindings.length} new, ${resolvedFindings.length} resolved, ` +
                `${persistentFindings.length} persistent finding(s)`;
  if (scoreDelta != null) {
    summary += ` · score ${runA.score} → ${runB.score} (${scoreDelta >= 0 ? '+' : ''}${scoreDelta})`;
  } else {
    summary += ' · score delta unavailable (a run has no score)';
  }

  return { newFindings, resolvedFindings, persistentFindings, scoreDelta, summary };
}
