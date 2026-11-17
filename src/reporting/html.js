/**
 * reporting/html.js — self-contained HTML report for a run.
 *
 * One file, zero external assets (inline CSS, no JavaScript): the artifact
 * you paste into a ticket, attach to a release, or drop on a share. Severity
 * summary, findings table, optional baseline diff and WCAG compliance
 * sections. Waived findings are shown separately, with their waiver reason.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityCounts(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]));
  for (const f of findings) {
    const sev = String(f.severity || 'info');
    counts[sev] = (counts[sev] || 0) + 1;
  }
  return counts;
}

function topRules(findings, limit = 12) {
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

const CSS = `
  :root { --bg:#0b1020; --panel:#141b38; --line:#26305a; --text:#e7ebf7; --muted:#9aa4c7;
          --accent:#4f8cff; --ok:#37d0a2; --warn:#ffb454; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.55; }
  .wrap { max-width:1080px; margin:0 auto; padding:32px 24px 64px; }
  h1 { font-size:26px; margin:0 0 6px; }
  .meta { color:var(--muted); font-size:13.5px; margin-bottom:22px; }
  .verdict { display:inline-block; padding:4px 14px; border-radius:999px; font-weight:700; font-size:15px; }
  .verdict.pass { background:#12321f; color:var(--ok); }
  .verdict.fail { background:#3a1414; color:var(--bad); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0 30px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat .n { font-size:24px; font-weight:700; }
  .stat .l { font-size:12.5px; color:var(--muted); }
  h2 { font-size:19px; margin:34px 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; color:#c9d4f2; }
  .sev { font-weight:700; }
  .sev.critical { color:var(--bad); } .sev.high { color:var(--bad); }
  .sev.medium { color:var(--warn); } .sev.low { color:var(--muted); } .sev.info { color:var(--muted); }
  .waived-note { color:var(--muted); font-size:13px; margin-top:10px; }
  .muted { color:var(--muted); }
  footer { margin-top:44px; color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); padding-top:16px; }
`;

/**
 * @param {object} run   — run record ({ url, runId, score, findings, compliance, ... })
 * @param {object} [opts]
 * @param {object|null} [opts.diff]        — runDiff result
 * @param {object|null} [opts.gate]        — { failed, reason }
 * @param {object|null} [opts.waiverResult] — applyWaivers result ({ waived, warnings })
 * @returns {string} complete standalone HTML document
 */
export function toHtml(run, { diff = null, gate = null, waiverResult = null } = {}) {
  const findings = Array.isArray(run?.findings) ? run.findings : [];
  const counts = severityCounts(findings);
  const failed = gate ? Boolean(gate.failed) : false;
  const verdict = failed ? '❌ FAIL' : '✅ PASS';
  const score = run?.score == null ? '—' : `${run.score}/100`;
  const waivedList = waiverResult?.waived || [];

  const lines = [];
  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push(`<title>QualityPilot report — ${esc(run?.url || 'target')}</title>`);
  lines.push(`<style>${CSS}</style>`);
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<div class="wrap">');

  lines.push(`<h1>QualityPilot report — ${esc(run?.url || 'target')}</h1>`);
  lines.push(`<div class="meta">run <code>${esc(run?.runId || '—')}</code> · finished ${esc(run?.timestamp || '—')} · gate <span class="verdict ${failed ? 'fail' : 'pass'}">${verdict}</span>${gate?.reason ? ` · ${esc(gate.reason)}` : ''}</div>`);

  lines.push('<div class="stats">');
  lines.push(`<div class="stat"><div class="n">${esc(score)}</div><div class="l">quality score</div></div>`);
  lines.push(`<div class="stat"><div class="n">${findings.length}</div><div class="l">findings</div></div>`);
  if (diff) {
    lines.push(`<div class="stat"><div class="n">${diff.newFindings.length}</div><div class="l">new vs baseline</div></div>`);
    lines.push(`<div class="stat"><div class="n">${diff.resolvedFindings.length}</div><div class="l">resolved</div></div>`);
  }
  if (waivedList.length) {
    lines.push(`<div class="stat"><div class="n">${waivedList.length}</div><div class="l">waived (see below)</div></div>`);
  }
  lines.push('</div>');

  lines.push('<h2>Findings by severity</h2>');
  lines.push('<table><tr><th>Severity</th><th>Count</th></tr>');
  for (const sev of SEVERITY_ORDER) {
    if (counts[sev] > 0) lines.push(`<tr><td class="sev ${sev}">${sev}</td><td>${counts[sev]}</td></tr>`);
  }
  lines.push('</table>');

  if (diff) {
    lines.push(`<h2>Baseline diff — ${esc(diff.baselineRunId || 'baseline')}</h2>`);
    lines.push(`<p class="muted">${esc(diff.summary)}</p>`);
    if (diff.newFindings.length > 0) {
      lines.push('<table><tr><th>New finding</th><th>Severity</th><th>Page</th></tr>');
      for (const f of diff.newFindings.slice(0, 25)) {
        lines.push(`<tr><td>${esc(f.title)}</td><td class="sev ${esc(f.severity)}">${esc(f.severity)}</td><td class="mono">${esc(f.pageUrl || '—')}</td></tr>`);
      }
      lines.push('</table>');
    }
  }

  lines.push('<h2>Findings</h2>');
  lines.push('<table><tr><th>Severity</th><th>Rule</th><th>Title</th><th>Page</th><th>×</th></tr>');
  for (const f of findings) {
    lines.push(
      `<tr><td class="sev ${esc(f.severity)}">${esc(f.severity)}</td>` +
      `<td class="mono">${esc(f.ruleId || '—')}</td>` +
      `<td>${esc(f.title)}</td>` +
      `<td class="mono">${esc(f.pageUrl || '—')}</td>` +
      `<td>${esc(f.occurrences || 1)}</td></tr>`,
    );
  }
  lines.push('</table>');

  if (waivedList.length > 0) {
    lines.push(`<h2>Waived (${waivedList.length})</h2>`);
    lines.push('<table><tr><th>Rule</th><th>Title</th><th>Page</th></tr>');
    for (const f of waivedList) {
      lines.push(`<tr><td class="mono">${esc(f.ruleId || '—')}</td><td>${esc(f.title)}</td><td class="mono">${esc(f.pageUrl || '—')}</td></tr>`);
    }
    lines.push('</table>');
    for (const w of waiverResult?.warnings || []) lines.push(`<p class="waived-note">⚠ ${esc(w)}</p>`);
  }

  if (run?.compliance) {
    const c = run.compliance;
    lines.push('<h2>WCAG conformance</h2>');
    lines.push(`<p class="muted">${esc(c.conformancePct ?? '—')}% conformance · ${esc(c.checkedCount ?? 0)} criteria checked · ${esc(c.violatedCount ?? 0)} violated${c.partial ? ' · partial coverage (marked)' : ''}</p>`);
  }

  lines.push(`<footer>Generated by QualityPilot · self-contained report (no external assets) · run <code>${esc(run?.runId || '—')}</code></footer>`);
  lines.push('</div>');
  lines.push('</body>');
  lines.push('</html>');
  return lines.join('\n');
}
