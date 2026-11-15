/**
 * reporting/junit.js — JUnit XML output for CI systems (pain point #2).
 *
 * toJUnitXml(report) renders a run (the same object the HTML/JSON reports
 * consume) as JUnit XML so any CI (Jenkins, GitLab, GitHub Actions, Azure…)
 * can display QA findings as test results:
 *
 *   <testsuites>
 *     <testsuite name="links" tests="2" failures="2" skipped="0">
 *       <properties>
 *         <property name="score" value="78"/>
 *       </properties>
 *       <testcase name="broken-link on https://…" classname="links">
 *         <failure message="Broken link" severity="high">…</failure>
 *       </testcase>
 *       <testcase name="page-load-failure on https://…" classname="Scan Coverage">
 *         <skipped message="Page load failed: …" type="coverage-failure"/>
 *       </testcase>
 *     </testsuite>
 *   </testsuites>
 *
 * Grouping: one <testsuite> per executor/page group — findings carry no
 * executor field, so the category (the closest analogue) is used and the
 * page appears in the testcase name. Confirmed findings become <failure>;
 * coverage-failures and suspected findings become <skipped>. No dependencies.
 */

/** Escape a string for XML text/attribute context. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A finding is "skipped" (not a hard failure) when it is a coverage
 *  failure record or only suspected. */
function isSkipped(finding) {
  return finding.findingType === 'coverage-failure' ||
         finding.category === 'Scan Coverage' ||
         finding.confidence === 'suspected';
}

function suiteNameFor(finding) {
  return finding.executor || finding.category || 'general';
}

function testCaseNameFor(finding, seen) {
  const ruleId = finding.ruleId || finding.id || 'unknown';
  const page = finding.pageUrl || 'unknown page';
  let name = `${ruleId} on ${page}`;
  const n = (seen.get(name) || 0) + 1;
  seen.set(name, n);
  if (n > 1) name += ` #${n}`;
  return name;
}

function testcaseXml(finding, seen) {
  const name = esc(testCaseNameFor(finding, seen));
  const classname = esc(suiteNameFor(finding));
  const skipped = isSkipped(finding);

  if (skipped) {
    const type = finding.findingType === 'coverage-failure' || finding.category === 'Scan Coverage'
      ? 'coverage-failure'
      : 'suspected';
    const message = finding.title || finding.description || 'Skipped';
    return `    <testcase name="${name}" classname="${classname}">\n` +
           `      <skipped message="${esc(message)}" type="${type}"/>\n` +
           `    </testcase>`;
  }

  const severity = finding.severity || 'info';
  const message = finding.title || 'Untitled finding';
  const details = [
    finding.pageUrl ? `Page: ${finding.pageUrl}` : null,
    finding.description || null,
    finding.evidence ? `Evidence: ${finding.evidence}` : null,
  ].filter(Boolean).join('\n');

  return `    <testcase name="${name}" classname="${classname}">\n` +
         `      <failure message="${esc(message)}" severity="${esc(severity)}">${esc(details)}</failure>\n` +
         `    </testcase>`;
}

function suiteXml(name, findings, report) {
  const seen = new Map();
  const skippedCount = findings.filter(isSkipped).length;
  const failureCount = findings.length - skippedCount;

  const properties = [
    { name: 'score', value: report?.score != null ? String(report.score) : '' },
    { name: 'runId', value: report?.runId || '' },
    { name: 'url', value: report?.url || '' },
  ];

  const lines = [];
  lines.push(`  <testsuite name="${esc(name)}" tests="${findings.length}" failures="${failureCount}" skipped="${skippedCount}" errors="0">`);
  lines.push('    <properties>');
  for (const p of properties) {
    lines.push(`      <property name="${esc(p.name)}" value="${esc(p.value)}"/>`);
  }
  lines.push('    </properties>');
  for (const f of findings) {
    lines.push(testcaseXml(f, seen));
  }
  lines.push('  </testsuite>');
  return lines.join('\n');
}

/**
 * Render a run report as JUnit XML.
 *
 * @param {object} report — a run object (findings[], score, runId, url, …)
 * @returns {string} JUnit XML document
 */
export function toJUnitXml(report) {
  const findings = report?.findings || [];

  // Group findings into suites (executor/page groups).
  const groups = new Map();
  for (const f of findings) {
    const name = suiteNameFor(f);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  if (groups.size === 0) groups.set('qualitypilot', []);

  const suites = [...groups.entries()]
    .map(([name, fs]) => suiteXml(name, fs, report));

  const totalTests = findings.length;
  const totalSkipped = findings.filter(isSkipped).length;
  const totalFailures = totalTests - totalSkipped;

  const runName = report?.runId ? `SQA run ${report.runId}` : 'SQA run';
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="${esc(runName)}" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" errors="0">\n` +
    `${suites.join('\n')}\n` +
    `</testsuites>\n`;
}
