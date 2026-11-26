/**
 * reporting/markdown.js — compact job-summary markdown for the CI gate.
 *
 * Designed for `$GITHUB_STEP_SUMMARY`, PR comments, and pasting into tickets:
 * self-contained text, no external assets, tables that survive markdown
 * renderers. Optional baseline diff section (Phase 6 `--baseline`).
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function esc(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function shortUrl(url) {
  const s = String(url || '—');
  return s.length > 72 ? `${s.slice(0, 69)}…` : s;
}

function severityCounts(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]));
  for (const f of findings) {
    const sev = String(f.severity || 'info');
    counts[sev] = (counts[sev] || 0) + 1;
  }
  return counts;
}

/** Group findings by rule (fallback: title) and sort by severity then count. */
function topRules(findings, limit = 10) {
  const byRule = new Map();
  for (const f of findings) {
    const key = String(f.ruleId || f.title || 'unknown');
    const entry = byRule.get(key) || { ruleId: key, severity: f.severity || 'info', count: 0, pages: new Set() };
    entry.count += 1;
    if ((SEVERITY_RANK[f.severity] || 0) > (SEVERITY_RANK[entry.severity] || 0)) entry.severity = f.severity;
    if (f.pageUrl) entry.pages.add(f.pageUrl);
    byRule.set(key, entry);
  }
  return [...byRule.values()]
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.count - a.count)
    .slice(0, limit);
}

/**
 * @param {object} run   — run record ({ url, runId, score, findings, ... })
 * @param {object} [opts]
 * @param {object|null} [opts.diff] — result of services/runDiff.diffRuns
 * @param {object|null} [opts.gate] — { failed, reason }
 * @returns {string} markdown
 */
export function toMarkdown(run, { diff = null, gate = null } = {}) {
  const findings = Array.isArray(run?.findings) ? run.findings : [];
  const counts = severityCounts(findings);
  const failed = gate ? Boolean(gate.failed) : false;
  const status = failed ? '❌ FAIL' : '✅ PASS';
  const score = run?.score == null ? '—' : `${run.score}/100`;
  const newCount = diff ? diff.newFindings.length : null;

  const lines = [];
  lines.push(`## Testigator QA gate — ${esc(run?.url || 'target')}`);
  lines.push('');
  lines.push(`**${status}** · score **${score}** · ${findings.length} finding(s)` +
    (diff ? ` · **${newCount} new** vs baseline` : ''));
  lines.push('');

  // Severity table
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const sev of SEVERITY_ORDER) {
    if (counts[sev] > 0 || sev !== 'info') lines.push(`| ${sev} | ${counts[sev]} |`);
  }
  lines.push('');

  // Baseline diff section
  if (diff) {
    lines.push(`### vs baseline \`${esc(diff.baselineRunId || 'baseline')}\``);
    lines.push('');
    lines.push(`**${diff.newFindings.length} new** · ${diff.resolvedFindings.length} resolved · ${diff.persistentFindings.length} persistent` +
      (diff.scoreDelta != null ? ` · score ${diff.scoreDelta >= 0 ? '+' : ''}${diff.scoreDelta}` : ''));
    lines.push('');
    if (diff.newFindings.length > 0) {
      lines.push('| New finding | Severity | Page |');
      lines.push('|---|---|---|');
      for (const f of diff.newFindings.slice(0, 15)) {
        lines.push(`| ${esc(f.title)} | ${esc(f.severity)} | ${esc(shortUrl(f.pageUrl))} |`);
      }
      if (diff.newFindings.length > 15) lines.push(`| … ${diff.newFindings.length - 15} more | | |`);
      lines.push('');
    }
  }

  // Top rules
  const rules = topRules(findings);
  if (rules.length > 0) {
    lines.push('### Top rules');
    lines.push('');
    lines.push('| Rule | Severity | Findings | Pages |');
    lines.push('|---|---|---|---|');
    for (const r of rules) {
      lines.push(`| \`${esc(r.ruleId)}\` | ${esc(r.severity)} | ${r.count} | ${r.pages.size} |`);
    }
    lines.push('');
  }

  lines.push(`<sub>run \`${esc(run?.runId || '—')}\`${gate ? ` · ${esc(gate.reason)}` : ''}</sub>`);
  lines.push('');
  return lines.join('\n');
}
