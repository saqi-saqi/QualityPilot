/**
 * services/testData.js — test data management (zero LLM, pure code).
 *
 * Flow step values may reference ${PLACEHOLDER} variables (e.g. ${TEST_USER}
 * in a `fill` step). This module resolves them from, in order:
 *   1. data/testdata.json  — operator-maintained flat map { "key": "value" }
 *   2. process.env         — ONLY keys prefixed SQA_TD_ (prefix stripped)
 *
 * Secrets never belong in testdata.json — use SQA_TD_* env vars instead, and
 * keep the JSON file to placeholder/example values only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PREFIX = 'SQA_TD_';

// Project root is two levels up from this file (src/services/).
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DATA_FILE = path.join(PROJECT_ROOT, 'data', 'testdata.json');

let cachedFile = null;
let cachedFilePath = null;
let cachedFileMtime = 0;

/**
 * Read data/testdata.json (if present). Returns a flat { key: "string" } map.
 * Non-string values are stringified; nested objects/arrays are rejected with
 * a warning so a malformed file can't silently break substitution.
 */
export function readTestDataFile(filePath = DEFAULT_DATA_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {}; // file missing or unreadable — env-only
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[testData] data/testdata.json is not valid JSON (${err.message}) — ignoring file`);
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[testData] data/testdata.json must be a flat { "key": "value" } object — ignoring file');
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null || typeof v === 'object') {
      console.warn(`[testData] Ignoring non-string test data key "${k}" (values must be strings)`);
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Load the merged test-data map: data/testdata.json + SQA_TD_* env vars
 * (env wins — it's the more intentional, per-run source). The FILE is
 * cached by mtime; env vars are merged fresh on every call so runtime
 * SQA_TD_* changes are always picked up.
 */
export function loadTestData(filePath = DEFAULT_DATA_FILE) {
  const mtime = fileMtime(filePath);
  if (!cachedFile || cachedFilePath !== filePath || mtime !== cachedFileMtime) {
    cachedFile = readTestDataFile(filePath);
    cachedFilePath = filePath;
    cachedFileMtime = mtime;
  }

  const merged = { ...cachedFile };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(ENV_PREFIX) && v != null) {
      merged[k.slice(ENV_PREFIX.length)] = v;
    }
  }
  return merged;
}

/** Get a single test-data value (string) or undefined. */
export function get(key, filePath = DEFAULT_DATA_FILE) {
  if (key == null || key === '') return undefined;
  return loadTestData(filePath)[key];
}

/**
 * Replace every ${KEY} occurrence in `str` with the resolved value.
 * Callers may pass an extra scope (e.g. the flow's variable scope) that is
 * consulted FIRST, before the shared test-data store.
 * Unknown placeholders are left as literal text (the caller decides whether
 * to warn — the executor emits a warning event per unknown key).
 *
 * Returns { value, unknown: [keys] } so callers can surface warnings.
 */
export function substitute(str, opts = {}) {
  const extraScope = opts.scope && typeof opts.scope === 'object' ? opts.scope : null;
  const filePath = opts.filePath || DEFAULT_DATA_FILE;
  if (typeof str !== 'string' || !str.includes('${')) {
    return { value: str, unknown: [] };
  }
  const store = loadTestData(filePath);
  const unknown = new Set();
  const value = str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    if (extraScope && extraScope[key] !== undefined) return String(extraScope[key]);
    if (store[key] !== undefined) return String(store[key]);
    unknown.add(key);
    return match; // leave literal
  });
  return { value, unknown: [...unknown] };
}

/** All available test-data keys (file + env). */
export function keys(filePath = DEFAULT_DATA_FILE) {
  return Object.keys(loadTestData(filePath)).sort();
}

/** Clear the cache — mainly for tests. */
export function _clearCache() {
  cachedFile = null;
  cachedFilePath = null;
  cachedFileMtime = 0;
}
