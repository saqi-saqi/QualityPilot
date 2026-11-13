/**
 * matrix/flakyTracker.js — detect flaky tests across run history.
 *
 * A "flaky test" is one that:
 *   • Passes on some runs of the same target URL + scan configuration
 *   • Fails on others
 *   • Alternates pass/fail often enough to rule out a one-off fluke
 *
 * Detection algorithm (single source of truth: `detectFlakyFromRuns`):
 *   1. Group runs by target URL **and** a normalized options hash
 *      (mode, maxPages, depth, executor set) — runs made with different
 *      configurations must never be compared against each other.
 *   2. For each ruleId observed in any run of that group, build the ordered
 *      pass/fail outcome sequence (fail = rule appeared in findings).
 *   3. Count alternations — the number of times the outcome flips between
 *      consecutive runs. Require >= 3 alternations before labeling flaky
 *      (e.g. fail→pass→fail→pass). A rule that flips once or twice may just
 *      be a fix that landed mid-window, not non-determinism.
 *   4. Compute a flakiness ratio = failCount / (passCount + failCount).
 *
 * The tracker persists findings summaries per run (SQLite by default, JSON
 * file as fallback) so analysis doesn't need to re-read every historical run.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SqliteFlakyStore } from '../storage/flakyStore.js';
import { config } from '../utils/config.js';

const DEFAULT_HISTORY_FILE = 'flaky-history.json';

/** Minimum number of pass/fail flips before a rule is labeled flaky. */
export const MIN_FLAKY_ALTERNATIONS = 3;

/**
 * Normalize the run options that affect scan determinism into a stable key.
 * Runs with different (mode, maxPages, depth, executor set) are grouped
 * separately — a rule missing because the run scanned fewer pages is a
 * coverage difference, not flakiness.
 */
export function normalizeFlakyOptions(run) {
  const options = run?.options || {};
  const mode = run?.mode || options.mode || 'matrix';
  const maxPages = options.maxPages ?? 'default';
  const depth = options.maxDepth ?? 'default';
  const executors = Array.isArray(options.executors)
    ? [...new Set(options.executors.filter(Boolean))].sort().join(',')
    : '';
  return `mode=${mode}|maxPages=${maxPages}|depth=${depth}|executors=${executors}`;
}

/**
 * Build a per-run summary to persist for flaky tracking.
 * Just the fields we need: url, runId, startedAt, finding ruleIds, options key.
 * Accepts either full runs (findings[]) or already-summarized records
 * (ruleIds[] — e.g. rows coming through the JSON→SQLite migration).
 */
export function buildRunSummary(run) {
  const ruleIds = new Set([
    ...(run.findings || []).map(f => f.ruleId).filter(Boolean),
    ...(Array.isArray(run.ruleIds) ? run.ruleIds : []),
  ]);
  return {
    runId: run.runId,
    url: run.url,
    startedAt: run.startedAt,
    status: run.status,
    ruleIds,
    optionsKey: run.optionsKey || normalizeFlakyOptions(run),
  };
}

/**
 * FlakyTracker — persists + analyzes run history.
 *
 * Storage format (JSON fallback):
 *   {
 *     runs: Array<{ runId, url, startedAt, status, ruleIds: string[], optionsKey: string }>,
 *     updatedAt: ISO timestamp,
 *   }
 */
export class FlakyTracker {
  constructor({ dataDir, historyFile = DEFAULT_HISTORY_FILE, useSqlite, db } = {}) {
    // Honor config.dataDir (env SQA_DATA_DIR); the SQLite-vs-JSON heuristic
    // compares resolved paths so a custom SQA_DATA_DIR still gets SQLite.
    const resolvedDataDir = path.resolve(dataDir || config?.dataDir || path.join(process.cwd(), 'data'));
    this.dataDir = resolvedDataDir;
    this.historyFile = path.join(resolvedDataDir, historyFile);
    this._cache = null;
    const defaultDataDir = path.resolve(config?.dataDir || path.join(process.cwd(), 'data'));
    this.useSqlite = useSqlite ?? (resolvedDataDir === defaultDataDir || resolvedDataDir === path.resolve('./data'));
    if (this.useSqlite) {
      try {
        this._sqliteStore = new SqliteFlakyStore({ db });
      } catch {
        this.useSqlite = false;
      }
    }
  }

  async _load() {
    if (this._cache) return this._cache;
    if (!existsSync(this.historyFile)) {
      this._cache = { runs: [], updatedAt: null };
      return this._cache;
    }
    try {
      const text = await fs.readFile(this.historyFile, 'utf-8');
      this._cache = JSON.parse(text);
    } catch {
      this._cache = { runs: [], updatedAt: null };
    }
    return this._cache;
  }

  async _save() {
    if (!this._cache) return;
    this._cache.updatedAt = new Date().toISOString();
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.historyFile, JSON.stringify(this._cache, null, 2), 'utf-8');
  }

  /**
   * Record a completed run.
   * Idempotent — re-recording the same runId overwrites.
   */
  async recordRun(run) {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.recordRun(run);
    }
    const data = await this._load();
    const summary = buildRunSummary(run);
    // Convert Set to array for JSON serialization
    const record = {
      runId: summary.runId,
      url: summary.url,
      startedAt: summary.startedAt,
      status: summary.status,
      ruleIds: Array.from(summary.ruleIds),
      optionsKey: summary.optionsKey,
    };

    // Replace if runId already exists
    const idx = data.runs.findIndex(r => r.runId === record.runId);
    if (idx >= 0) {
      data.runs[idx] = record;
    } else {
      data.runs.push(record);
    }

    // Sort by startedAt so we can analyze history in order
    data.runs.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

    await this._save();
  }

  /**
   * Compute flaky tests across all recorded runs.
   * Delegates to the shared algorithm in detectFlakyFromRuns().
   */
  async detectFlakyTests() {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.detectFlakyTests();
    }
    const data = await this._load();
    return detectFlakyFromRuns(data.runs);
  }

  /**
   * Get all recorded runs (for debugging / UI display).
   */
  async listRuns() {
    const data = await this._load();
    return data.runs;
  }

  /**
   * Clear all history. Used by tests + manual reset.
   */
  async clear() {
    this._cache = { runs: [], updatedAt: null };
    await this._save();
  }

  /**
   * Get stats about the history itself.
   */
  async stats() {
    const data = await this._load();
    return {
      totalRuns: data.runs.length,
      uniqueUrls: new Set(data.runs.map(r => r.url)).size,
      uniqueRuleIds: new Set(data.runs.flatMap(r => r.ruleIds || [])).size,
      updatedAt: data.updatedAt,
    };
  }
}

/**
 * Detect flaky tests from a list of runs — THE single flakiness algorithm.
 *
 * Accepts run records in either shape:
 *   • full runs with a `findings` array (ruleId extracted per finding)
 *   • persisted summaries with a `ruleIds` array
 * Both may carry `optionsKey` (or full `options`, which get normalized here).
 *
 * Useful for the dashboard's trends view + unit testing.
 */
export function detectFlakyFromRuns(runs) {
  const completed = (runs || []).filter(r => r.status === 'completed');

  // Group by URL + normalized options — the comparison key
  const byGroup = new Map();
  for (const run of completed) {
    const optionsKey = run.optionsKey || normalizeFlakyOptions(run);
    const key = `${run.url}::${optionsKey}`;
    if (!byGroup.has(key)) byGroup.set(key, { url: run.url, optionsKey, runs: [] });
    byGroup.get(key).runs.push(run);
  }

  // Sort each group chronologically before analyzing outcome sequences
  for (const group of byGroup.values()) {
    group.runs.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  }

  const flaky = [];

  for (const { url, optionsKey, runs: groupRuns } of byGroup.values()) {
    if (groupRuns.length < 2) continue;  // need ≥2 runs to detect anything

    const allRuleIds = new Set();
    for (const r of groupRuns) {
      for (const id of ruleIdsOf(r)) allRuleIds.add(id);
    }

    for (const ruleId of allRuleIds) {
      let passCount = 0;
      let failCount = 0;
      let alternations = 0;
      let lastFailedAt = null;
      let previousFailed = null;

      for (const r of groupRuns) {
        const failed = ruleIdsOf(r).includes(ruleId);
        if (failed) {
          failCount++;
          if (!lastFailedAt || new Date(r.startedAt) > new Date(lastFailedAt)) {
            lastFailedAt = r.startedAt;
          }
        } else {
          passCount++;
        }
        // Count outcome flips between consecutive runs
        if (previousFailed !== null && failed !== previousFailed) {
          alternations++;
        }
        previousFailed = failed;
      }

      // Flaky: the outcome must flip back and forth at least 3 times
      // (e.g. fail→pass→fail→pass). One or two flips can be explained by a
      // fix/regression landing mid-window — that's a trend, not flakiness.
      if (alternations >= MIN_FLAKY_ALTERNATIONS) {
        flaky.push({
          ruleId,
          url,
          optionsKey,
          passCount,
          failCount,
          totalRuns: passCount + failCount,
          alternations,
          flakinessRatio: failCount / (passCount + failCount),
          lastFailedAt,
        });
      }
    }
  }

  // Sort by flakiness ratio desc, then by failCount desc
  flaky.sort((a, b) => {
    if (b.flakinessRatio !== a.flakinessRatio) {
      return b.flakinessRatio - a.flakinessRatio;
    }
    return b.failCount - a.failCount;
  });

  return flaky;
}

/** Extract the ruleId list from either run shape (findings[] or ruleIds[]). */
function ruleIdsOf(run) {
  if (Array.isArray(run.ruleIds)) return run.ruleIds;
  if (Array.isArray(run.findings)) {
    return run.findings.map(f => f.ruleId).filter(Boolean);
  }
  return [];
}
