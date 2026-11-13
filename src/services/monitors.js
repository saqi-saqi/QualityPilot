/**
 * services/monitors.js — persistent monitor configurations + due logic.
 *
 * A "monitor" is a site the agent watches on a schedule (Rung 3: nightly
 * monitoring for a few trusted clients). Monitors live in
 * `<dataDir>/monitors.json` so they survive restarts, and the scheduler
 * (scheduler.js) turns them into runs via runManager.
 *
 * Monitor shape:
 *   {
 *     id:              string  — short unique slug
 *     label:           string  — human name (client/site)
 *     url:             string  — site to scan (http/https only, SSRF-checked)
 *     roles:           string[] — session roles to record/scan (default [])
 *     options:         object  — run options (maxPages, maxDepth, executors…)
 *     intervalHours:   number  — how often to run (min 1)
 *     enabled:         boolean
 *     onlyNewFindings: boolean — file/publish only findings not present in the
 *                                previous completed run (regressions only)
 *     webhookUrl:      string  — optional per-monitor webhook override
 *     // state (managed by scheduler/runs):
 *     lastRunAt:       string|null — ISO timestamp of last triggered run
 *     lastRunId:       string|null
 *     lastScore:       number|null
 *     lastStatus:      string|null — 'completed' | 'failed' | 'running' | 'queued'
 *   }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SqliteMonitorStore } from '../storage/monitorStore.js';
import { validateUrl } from './ssrf.js';
import { config } from '../utils/config.js';

const RUN_OPTIONS_SCHEMA = z.object({
  maxPages: z.number().int().min(1).max(100).optional(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  browsers: z.array(z.string()).optional(),
  viewports: z.array(z.any()).optional(),
  executors: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  dedup: z.boolean().optional(),
}).strict();

export const MonitorSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  label: z.string().min(1).max(120),
  // http/https only — a monitor must never point the recording/scan browsers
  // at file://, ftp:// or other schemes. (DNS/SSRF checks run in add()/update().)
  url: z.string().url().refine((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'url must use the http or https scheme' }),
  // Session roles recorded/used for this monitor (e.g. ['default', 'admin']).
  roles: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)).default([]),
  options: RUN_OPTIONS_SCHEMA.default({}),
  intervalHours: z.number().min(1).max(24 * 30).default(24),
  enabled: z.boolean().default(true),
  onlyNewFindings: z.boolean().default(true),
  webhookUrl: z.string().url().optional().or(z.literal('')).default(''),

  // ─── state ───
  lastRunAt: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  lastScore: z.number().nullable().default(null),
  lastStatus: z.string().nullable().default(null),
});

// ─── pure helpers (unit-tested) ──────────────────────────────────────

/** True when the monitor should run at time `now` (ms epoch). */
export function isDue(monitor, now = Date.now()) {
  if (!monitor.enabled) return false;
  if (!monitor.lastRunAt) return true;
  const last = Date.parse(monitor.lastRunAt);
  if (Number.isNaN(last)) return true;
  return now - last >= monitor.intervalHours * 3600 * 1000;
}

/** Next time the monitor would run, as ISO (or null when never/disabled). */
export function nextRunAt(monitor) {
  if (!monitor.enabled) return null;
  if (!monitor.lastRunAt) return new Date().toISOString();
  const last = Date.parse(monitor.lastRunAt);
  if (Number.isNaN(last)) return new Date().toISOString();
  return new Date(last + monitor.intervalHours * 3600 * 1000).toISOString();
}

// ─── store ───────────────────────────────────────────────────────────

export class MonitorStore {
  constructor(dataDir, { useSqlite, db } = {}) {
    // Honor config.dataDir (env SQA_DATA_DIR); the SQLite-vs-JSON heuristic
    // compares resolved paths so a custom SQA_DATA_DIR still gets SQLite.
    const resolvedDataDir = path.resolve(dataDir || config?.dataDir || path.join(process.cwd(), 'data'));
    this.filePath = path.join(resolvedDataDir, 'monitors.json');
    this._monitors = null;
    const defaultDataDir = path.resolve(config?.dataDir || path.join(process.cwd(), 'data'));
    this.useSqlite = useSqlite ?? (resolvedDataDir === defaultDataDir || resolvedDataDir === path.resolve('./data'));
    if (this.useSqlite) {
      try {
        this._sqliteStore = new SqliteMonitorStore({ db });
      } catch {
        this.useSqlite = false;
      }
    }
  }

  async _load() {
    if (this._monitors) return this._monitors;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this._monitors = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Failed to read ${this.filePath}:`, err.message);
      }
      this._monitors = [];
    }
    return this._monitors;
  }

  async _save(monitors) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(monitors, null, 2));
    this._monitors = monitors;
  }

  async list() {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.list();
    }
    return [...(await this._load())];
  }

  async get(id) {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.get(id);
    }
    const monitors = await this._load();
    return monitors.find(m => m.id === id) || null;
  }

  /**
   * SSRF gate — a monitor URL must resolve to a scannable http(s) target
   * BEFORE it is persisted, so a crafted monitor can never point the
   * recording/scan browsers at private ranges or file://-style resources.
   * The ssrf error message is surfaced verbatim.
   */
  async _assertScannableUrl(url) {
    try {
      await validateUrl(url);
    } catch (err) {
      return `url: ${err.message}`;
    }
    return null;
  }

  /** Validate + add. Returns { ok, monitor } | { ok:false, error }. */
  async add(input) {
    const parsed = MonitorSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const urlError = await this._assertScannableUrl(parsed.data.url);
    if (urlError) {
      return { ok: false, error: urlError };
    }
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.add(input);
    }
    const monitors = await this._load();
    if (monitors.some(m => m.id === parsed.data.id)) {
      return { ok: false, error: `Monitor id already exists: ${parsed.data.id}` };
    }
    monitors.push(parsed.data);
    await this._save(monitors);
    return { ok: true, monitor: parsed.data };
  }

  async remove(id) {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.remove(id);
    }
    const monitors = await this._load();
    const next = monitors.filter(m => m.id !== id);
    if (next.length === monitors.length) return false;
    await this._save(next);
    return true;
  }

  /** Merge a partial update (usually state fields) into a monitor. */
  async update(id, patch) {
    // A monitor URL is also settable through update — same SSRF gate as add().
    // Throws so HTTP callers surface a 400 with the ssrf error message.
    if (patch && typeof patch.url === 'string' && patch.url) {
      const urlError = await this._assertScannableUrl(patch.url);
      if (urlError) {
        throw new Error(urlError);
      }
    }
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.update(id, patch);
    }
    const monitors = await this._load();
    const idx = monitors.findIndex(m => m.id === id);
    if (idx === -1) return null;
    monitors[idx] = { ...monitors[idx], ...patch };
    await this._save(monitors);
    return monitors[idx];
  }

  async dueMonitors(now = Date.now()) {
    if (this.useSqlite && this._sqliteStore) {
      return this._sqliteStore.dueMonitors(now);
    }
    const monitors = await this._load();
    return monitors.filter(m => isDue(m, now));
  }
}
