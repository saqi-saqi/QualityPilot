/**
 * integrations/issueTracker.js — abstract interface for pushing findings
 * to issue trackers (GitHub Issues, Jira, etc.).
 *
 * Interface (IssueTrackerAdapter):
 *   {
 *     name:    string,
 *     search:  async ({ ruleId, signature }) => Issue | null,
 *                  Find an existing open issue matching the signature
 *     create:  async ({ title, body, labels, severity }) => Issue,
 *                  Create a new issue
 *     update:  async (issue, { body, labels, comment? }) => Issue,
 *                  Update an existing issue (e.g. add a comment for re-occurrence)
 *     close:   async (issue, { reason }) => Issue,
 *                  Close an issue (e.g. when the finding no longer appears)
 *   }
 *
 * Issue shape:
 *   { id, url, state, title, labels: string[], _signature?: string }
 *
 * Signatures:
 *   findingSignature(f)  — LEGACY coarse signature `ruleId::origin+path`.
 *                          Kept for backward compatibility: issues filed by
 *                          older versions carry it, and search still matches it.
 *   fineSignature(f)     — element-level signature `ruleId::origin+path::element`
 *                          where element = the finding's primary selector/target
 *                          (arrays stringified) or a short hash of the title.
 *                          Two distinct violations of the same rule on the same
 *                          page file as two separate issues.
 *
 * Lifecycle (managed by IssueTrackerPublisher):
 *   1. Take findings from a completed run
 *   2. Group by fine-grained signature
 *   3. For each group:
 *      • search() by fine signature → existing issue? → update() it
 *      • else search() by legacy coarse signature → old issue still open?
 *        → comment on the legacy issue (no new issue while it's open)
 *      • else → create() with the finding details
 *   4. Optionally: close issues whose findings no longer appear — but ONLY
 *      for pages actually crawled in the current run (coverage guard), so a
 *      partial scan can never close real bugs on pages it never visited.
 */

// Audit H-3: one credential-scrubbing boundary shared with MCP responses.
import { scrubText } from '../mcp/redact.js';

const SEVERITY_LABELS = {
  critical: 'P0-critical',
  high:     'P1-high',
  medium:   'P2-medium',
  low:      'P3-low',
  info:     'P4-info',
};

/**
 * FNV-1a 32-bit hash → 8 hex chars. Stable across runs/platforms; used to
 * derive an element key from the finding title when no selector exists.
 */
function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalize a page URL to `origin + path` (query strings stripped so
 * ?foo=bar doesn't fragment signatures).
 */
function cleanPageUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return u.origin + u.pathname;
  } catch {
    return pageUrl || '';
  }
}

/**
 * The element-level part of a fine-grained signature:
 * the finding's primary selector/target (arrays are stringified), or a
 * short hash of the title when no selector is available.
 */
export function elementKey(finding) {
  const raw = finding.selector ?? finding.target ?? finding.element ?? null;
  if (raw != null && raw !== '') {
    const s = Array.isArray(raw) ? raw.join('|') : String(raw);
    return s.length > 120 ? s.slice(0, 120) : s;
  }
  return shortHash(finding.title || '');
}

/**
 * Compute the LEGACY (coarse) signature for a finding:
 *   `ruleId::origin+path`
 * Two findings with the same coarse signature were historically treated as
 * the same bug. Kept stable so old issues still dedupe.
 */
export function findingSignature(finding) {
  const ruleId = finding.ruleId || finding.id || 'unknown';
  return `${ruleId}::${cleanPageUrl(finding.pageUrl)}`;
}

/**
 * Compute the fine-grained (element-level) signature for a finding:
 *   `ruleId::origin+path::element`
 */
export function fineSignature(finding) {
  return `${findingSignature(finding)}::${elementKey(finding)}`;
}

/**
 * Pull the page URL (`origin + path`) out of a signature — works for both
 * coarse (`ruleId::url`) and fine (`ruleId::url::element`) formats.
 * Returns null when the signature carries no URL.
 */
export function pageFromSignature(signature) {
  if (typeof signature !== 'string') return null;
  const parts = signature.split('::');
  const url = parts.length >= 2 ? parts[1] : '';
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Build a Markdown body for an issue from a finding.
 *
 * Audit H-3: tracker bodies are an EXTERNAL destination. Evidence and
 * descriptions routinely embed Set-Cookie values, response bodies and
 * session replays, so every free-text field is scrubbed through the same
 * credential boundary used for MCP responses before it leaves the process.
 */
export function buildIssueBody(finding, runContext = {}) {
  const lines = [];
  const safe = (value) => scrubText(value);

  lines.push(`### ${finding.title || 'Untitled finding'}`);
  lines.push('');

  if (finding.description) {
    lines.push(safe(finding.description));
    lines.push('');
  }

  lines.push('#### Details');
  lines.push('');
  lines.push(`- **Severity:** ${finding.severity || 'info'}`);
  lines.push(`- **Confidence:** ${finding.confidence || 'unknown'}`);
  lines.push(`- **Category:** ${finding.category || 'general'}`);
  lines.push(`- **Rule ID:** \`${finding.ruleId || 'n/a'}\``);

  if (finding.origin) {
    lines.push(`- **Origin:** ${finding.origin}`);
  }

  if (finding.pageUrl) {
    lines.push(`- **Page:** [${finding.pageUrl}](${finding.pageUrl})`);
  }

  if (finding.occurrences > 1) {
    lines.push(`- **Occurrences:** ${finding.occurrences}`);
    if (finding.affectedPages?.length) {
      lines.push('- **Affected pages:**');
      for (const p of finding.affectedPages.slice(0, 10)) {
        lines.push(`  - ${p}`);
      }
      if (finding.affectedPages.length > 10) {
        lines.push(`  - _...and ${finding.affectedPages.length - 10} more_`);
      }
    }
  }

  if (runContext.runId) {
    lines.push(`- **Run ID:** \`${runContext.runId}\``);
    // Link to the run dashboard when SQA_DASHBOARD_URL is configured
    // (runContext.dashboardUrl overrides the env for tests).
    const dashBase = (runContext.dashboardUrl || process.env.SQA_DASHBOARD_URL || '').replace(/\/$/, '');
    if (dashBase) {
      lines.push(`- **Dashboard:** [view run](${dashBase}/runs/${runContext.runId})`);
    }
  }
  if (runContext.url) {
    lines.push(`- **Target:** ${runContext.url}`);
  }
  if (runContext.matrixCells?.length) {
    lines.push(`- **Observed in matrix cells:** ${runContext.matrixCells.join(', ')}`);
  }

  lines.push('');

  if (finding.evidence) {
    lines.push('#### Evidence');
    lines.push('');
    lines.push('```');
    lines.push(safe(finding.evidence));
    lines.push('```');
    lines.push('');
  }

  // Screenshot filenames referenced by the finding (used by the dashboard
  // to serve them at /api/runs/<runId>/screenshots/<file>)
  const screenshots = [];
  if (finding.screenshot) screenshots.push(finding.screenshot);
  if (Array.isArray(finding.screenshots)) {
    screenshots.push(...finding.screenshots.filter(Boolean));
  }
  if (screenshots.length) {
    lines.push('#### Screenshots');
    lines.push('');
    for (const s of Array.from(new Set(screenshots))) {
      lines.push(`- \`${s}\``);
    }
    lines.push('');
  }

  if (finding.reproSteps?.length) {
    lines.push('#### Repro Steps');
    lines.push('');
    finding.reproSteps.forEach((step, i) => {
      lines.push(`${i + 1}. ${safe(step)}`);
    });
    lines.push('');
  }

  if (finding.suggestedFix) {
    lines.push('#### Suggested Fix');
    lines.push('');
    lines.push(safe(finding.suggestedFix));
    lines.push('');
  }

  lines.push('---');
  lines.push('_This issue was auto-filed by QualityPilot. Do not edit the title or signature._');

  return lines.join('\n');
}

/**
 * Group findings by FINE-grained signature, picking the most severe as the
 * representative. Returns a Map: fineSignature → {
 *   signature,         — fine signature (used to file/update issues)
 *   coarseSignature,   — legacy signature (used for legacy dedup + auto-close)
 *   finding,           — representative (most severe)
 *   allOccurrences,
 * }
 */
export function groupFindingsBySignature(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const sig = fineSignature(finding);
    if (!groups.has(sig)) {
      groups.set(sig, {
        signature: sig,
        coarseSignature: findingSignature(finding),
        finding,
        allOccurrences: finding.occurrences || 1,
      });
    } else {
      const existing = groups.get(sig);
      existing.allOccurrences += finding.occurrences || 1;

      // Keep the most severe as representative
      const sevRank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
      if ((sevRank[finding.severity] || 0) > (sevRank[existing.finding.severity] || 0)) {
        existing.finding = finding;
      }
    }
  }

  return groups;
}

/**
 * Build the label set for a finding issue.
 */
export function labelsForFinding(finding, options = {}) {
  const labels = [];

  // Severity label
  if (finding.severity && SEVERITY_LABELS[finding.severity]) {
    labels.push(SEVERITY_LABELS[finding.severity]);
  }

  // Category label
  if (finding.category) {
    labels.push(`category:${finding.category}`);
  }

  // Origin label
  if (finding.origin) {
    labels.push(`origin:${finding.origin}`);
  }

  // Custom labels from options
  if (options.extraLabels?.length) {
    labels.push(...options.extraLabels);
  }

  // Always include "qualitypilot" so users can filter
  labels.push('qualitypilot');

  // Dedup
  return Array.from(new Set(labels));
}

/**
 * Normalize the run's crawled/covered pages into a Set of `origin + path`
 * strings. Accepts:
 *   runContext.coveredPages — Set | Array of URLs (or {url} objects)
 *   runContext.pages        — Array of URLs (or page objects with .url)
 * Returns null when no coverage info is available at all (caller should
 * then skip the auto-close sweep entirely).
 */
function normalizeCoveredPages(runContext) {
  const raw = runContext.coveredPages ?? runContext.pages;
  if (raw == null) return null;
  const entries = raw instanceof Set ? Array.from(raw) : raw;
  if (!Array.isArray(entries)) return null;
  const out = new Set();
  for (const entry of entries) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url) continue;
    out.add(cleanPageUrl(url));
  }
  return out;
}

/**
 * IssueTrackerPublisher — orchestrates search/create/update per finding.
 */
export class IssueTrackerPublisher {
  constructor({ adapter, options = {} } = {}) {
    if (!adapter) throw new Error('IssueTrackerPublisher requires an adapter');
    if (typeof adapter.search !== 'function' ||
        typeof adapter.create !== 'function' ||
        typeof adapter.update !== 'function') {
      throw new Error('Adapter must implement search, create, update');
    }
    this.adapter = adapter;
    this.options = {
      minSeverity: 'medium',  // don't auto-file low/info findings
      dryRun: false,
      closeResolved: false,
      ...options,
    };
  }

  /**
   * Publish findings to the issue tracker.
   * runContext may carry coverage info so the auto-close sweep can tell
   * which pages were actually crawled this run:
   *   { runId, url, pages | coveredPages, dashboardUrl, matrixCells }
   * Returns { filed, updated, skipped, closed, errors, legacyUpdated, autoCloseSkipped }
   */
  async publish(findings, runContext = {}) {
    const stats = { filed: 0, updated: 0, skipped: 0, closed: 0, errors: [], legacyUpdated: 0, autoCloseSkipped: 0 };

    // Filter by minSeverity
    const sevRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const minRank = sevRank[this.options.minSeverity] ?? 2;

    const eligible = findings.filter(f =>
      (sevRank[f.severity] || 0) >= minRank
    );

    if (eligible.length === 0) {
      // Even with no findings, we may want to close resolved issues
      if (this.options.closeResolved && typeof this.adapter.listOpen === 'function') {
        await this._closeResolved({ fine: new Set(), coarse: new Set() }, runContext, stats);
      }
      return stats;
    }

    // Group by fine-grained signature
    const groups = groupFindingsBySignature(eligible);

    // Track which signatures are present in this run (for auto-close).
    // Both fine AND coarse: a legacy issue carries the coarse signature, so
    // it must stay open as long as any of its findings re-occur.
    const presentFine = new Set();
    const presentCoarse = new Set();
    for (const [, group] of groups) {
      presentFine.add(group.signature);
      presentCoarse.add(group.coarseSignature);
    }

    for (const [, group] of groups) {
      const { signature, coarseSignature, finding, allOccurrences } = group;

      try {
        if (this.options.dryRun) {
          // Dry-run: log what we would do, don't make API calls
          stats.filed++;
          continue;
        }

        // 1. Search for an existing issue by the fine (element-level) signature
        const existing = await this.adapter.search({ ruleId: finding.ruleId, signature });

        if (existing) {
          // Update with new occurrence info
          const comment = `**Re-occurred** in run \`${runContext.runId || 'unknown'}\` (${new Date().toISOString()})\n` +
                          `Occurrences: ${allOccurrences}`;
          await this.adapter.update(existing, {
            labels: labelsForFinding(finding, this.options),
            comment,
          });
          stats.updated++;
          continue;
        }

        // 2. Backward compat: look for a legacy coarse-signature issue
        //    (filed by older versions that grouped per rule+page). While
        //    such an issue is open we comment on it instead of filing a
        //    fine-grained duplicate.
        if (coarseSignature !== signature) {
          const legacy = await this.adapter.search({ ruleId: finding.ruleId, signature: coarseSignature });
          if (legacy) {
            const comment = `**Re-occurred** (element: \`${elementKey(finding)}\`) in run \`${runContext.runId || 'unknown'}\` (${new Date().toISOString()})\n` +
                            `Occurrences: ${allOccurrences}`;
            await this.adapter.update(legacy, {
              labels: labelsForFinding(finding, this.options),
              comment,
            });
            stats.updated++;
            stats.legacyUpdated++;
            continue;
          }
        }

        // 3. No match at all → create a new fine-grained issue
        await this.adapter.create({
          title: `[SQA] ${finding.title}`,
          body: buildIssueBody(finding, runContext),
          labels: labelsForFinding(finding, this.options),
          severity: finding.severity,
          signature,
        });
        stats.filed++;
      } catch (err) {
        stats.errors.push({
          signature,
          finding: finding.title,
          error: err.message,
        });
      }
    }

    // Auto-close: list open issues with the qualitypilot label and close any
    // whose signature is no longer present in this run — restricted to pages
    // actually crawled this run (coverage guard).
    if (this.options.closeResolved && typeof this.adapter.listOpen === 'function') {
      await this._closeResolved({ fine: presentFine, coarse: presentCoarse }, runContext, stats);
    }

    return stats;
  }

  /**
   * Close issues that no longer appear in the current run.
   *
   * Coverage guard: only issues whose page (extracted from the signature)
   * was actually crawled/covered by THIS run are eligible. Issues on pages
   * that were not visited are left open — a partial scan must never close
   * real bugs. When the run provides no coverage info at all, the whole
   * sweep is skipped.
   */
  async _closeResolved(presentSignatures, runContext, stats) {
    const coveredPages = normalizeCoveredPages(runContext);
    if (!coveredPages) {
      // No coverage info in the run context — cannot verify which pages were
      // visited, so auto-close would risk closing bugs on unscanned pages.
      return;
    }

    try {
      const openIssues = await this.adapter.listOpen();
      for (const issue of openIssues) {
        const sig = issue._signature;
        if (!sig) continue;  // Can't match without a signature
        if (presentSignatures.fine.has(sig) || presentSignatures.coarse.has(sig)) continue;  // Still present — leave open

        const issuePage = pageFromSignature(sig);
        if (!issuePage || !coveredPages.has(issuePage)) {
          // Page wasn't visited this run (or has no page) — skip auto-close.
          stats.autoCloseSkipped++;
          continue;
        }

        try {
          await this.adapter.close(issue, {
            reason: 'completed',
          });
          stats.closed++;
        } catch (err) {
          stats.errors.push({
            signature: sig,
            finding: issue.title,
            error: `close failed: ${err.message}`,
          });
        }
      }
    } catch (err) {
      stats.errors.push({
        signature: '__close_resolved__',
        finding: 'auto-close sweep',
        error: err.message,
      });
    }
  }
}
