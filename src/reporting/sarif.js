/**
 * reporting/sarif.js — SARIF 2.1.0 output for CI code-scanning integration.
 *
 * toSarif(report) renders a run (the same object the HTML/JSON reports
 * consume) as a SARIF 2.1.0 log so GitHub Advanced Security, Azure DevOps,
 * CodeQL consumers, etc. can display QA findings inline:
 *
 *   severity → level mapping:
 *     critical, high → 'error'
 *     medium         → 'warning'
 *     low, info      → 'note'
 *
 * Each finding becomes a result with the page URL as the artifact location
 * and a stable element-level signature in partialFingerprints (used by CI
 * systems to match/alert on the same issue across runs). No dependencies.
 */

import { fineSignature } from '../integrations/issueTracker.js';

const LEVEL_BY_SEVERITY = {
  critical: 'error',
  high:     'error',
  serious:  'error',     // axe severity used by accessibility findings
  medium:   'warning',
  moderate: 'warning',   // axe
  low:      'note',
  minor:    'note',      // axe
  info:     'note',
};

function levelFor(severity) {
  return LEVEL_BY_SEVERITY[String(severity || 'info').toLowerCase()] || 'note';
}

function messageTextFor(finding) {
  const title = finding.title || 'Untitled finding';
  return finding.description ? `${title} — ${finding.description}` : title;
}

/**
 * Render a run report as a SARIF 2.1.0 log object.
 *
 * @param {object} report — a run object (findings[], score, runId, url, …)
 * @returns {{version:'2.1.0', $schema:string, runs:Array}}
 */
export function toSarif(report) {
  const findings = report?.findings || [];

  // One rule entry per distinct ruleId (or finding id when ruleId is absent).
  const rules = new Map();
  for (const f of findings) {
    const ruleId = f.ruleId || f.id || 'unknown';
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        shortDescription: { text: f.title || ruleId },
      });
    }
  }

  const results = findings.map((f) => {
    const result = {
      ruleId: f.ruleId || f.id || 'unknown',
      level: levelFor(f.severity),
      message: { text: messageTextFor(f) },
      partialFingerprints: {
        signature: f.signature || fineSignature(f),
      },
    };
    if (f.pageUrl) {
      result.locations = [{
        physicalLocation: {
          artifactLocation: { uri: encodeURI(f.pageUrl) },
        },
      }];
    }
    // Audit M-2 (SARIF parity): a waived finding is still reported, but
    // marked suppressed so code scanning does not raise an alert the gate
    // deliberately accepted.
    if (f.waived === true) {
      result.suppressions = [{ kind: 'external', justification: 'waived in the team waiver file' }];
    }
    return result;
  });

  return {
    version: '2.1.0',
    $schema: 'https://json.sarif.org/schema/2.1.0/sarif-schema.json',
    runs: [{
      tool: {
        driver: {
          name: 'Testigator',
          informationUri: 'https://github.com/saqi-saqi/Testigator',
          rules: [...rules.values()],
        },
      },
      results,
      properties: {
        runId: report?.runId || null,
        url: report?.url || null,
        score: report?.score ?? null,
      },
    }],
  };
}
