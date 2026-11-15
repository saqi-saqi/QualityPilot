#!/usr/bin/env node
/**
 * Test runner entry that works on Node >= 20.
 *
 * The runner-glob form (double-star path pattern) relies on runner-side glob
 * expansion (Node >= 21 only) and directory mode is inconsistent across
 * versions/platforms, so we enumerate test files ourselves and pass them as
 * explicit positional args — stable on every supported version.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # all tests
 *   node scripts/run-tests.mjs test/ssrf    # only matching files (substring)
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testDir = join(root, 'test');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.test\.js$/.test(entry)) out.push(full);
  }
  return out;
}

const all = walk(testDir);
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = filter.length
  ? all.filter((f) => filter.some((pat) => relative(testDir, f).replaceAll(sep, '/').includes(pat)))
  : all;

if (files.length === 0) {
  console.error('No test files matched:', filter.join(', ') || '(none)');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) with node ${process.version} ...`);
const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
