/**
 * Verifies that every repository file/directory path and local Markdown link in
 * README.md resolves on disk (Remediation Plan WS3.1).
 *
 * Skips explicitly optional user-supplied config examples (e.g.
 * data/testrail-map.json, data/xray-map.json, data/.session.key) and code
 * identifiers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USER_SUPPLIED_RUNTIME_PATHS = new Set([
  'data/testrail-map.json',
  'data/xray-map.json',
  'data/.session.key',
  'data/sessions',
  'data/testdata.json',
  'benchmark/results',
  '.qualitypilot/artifacts',
]);

export function auditReadmePaths(repoRoot = process.cwd()) {
  const readmePath = path.join(repoRoot, 'README.md');
  const md = fs.readFileSync(readmePath, 'utf8');

  const pathRe = /`((?:src|dashboard|scripts|test|benchmark|landing|docs|\.github|data|\.env\.example|action\.yml|docker-compose\.yml|LICENSE|package\.json)(?:\/[A-Za-z0-9_.*-]+)*\/?)`/g;
  const checkedPaths = new Set();
  const missingPaths = [];

  let m;
  while ((m = pathRe.exec(md))) {
    const raw = m[1].replace(/\/$/, '');
    if (!raw || checkedPaths.has(raw)) continue;
    checkedPaths.add(raw);
    if (USER_SUPPLIED_RUNTIME_PATHS.has(raw) || raw.includes('*')) continue;
    if (!fs.existsSync(path.join(repoRoot, raw))) {
      missingPaths.push(raw);
    }
  }

  const linkRe = /\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g;
  const checkedLinks = new Set();
  const missingLinks = [];

  while ((m = linkRe.exec(md))) {
    const target = m[1].split('#')[0].trim().replace(/\/$/, '');
    if (!target || checkedLinks.has(target)) continue;
    checkedLinks.add(target);
    if (USER_SUPPLIED_RUNTIME_PATHS.has(target)) continue;
    if (!fs.existsSync(path.join(repoRoot, target))) {
      missingLinks.push(target);
    }
  }

  return {
    checkedPaths: checkedPaths.size,
    checkedLinks: checkedLinks.size,
    missingPaths,
    missingLinks,
    ok: missingPaths.length === 0 && missingLinks.length === 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = auditReadmePaths();
  console.log(`README path audit: ${res.checkedPaths} paths, ${res.checkedLinks} relative links checked.`);
  if (!res.ok) {
    if (res.missingPaths.length) console.error('Missing paths:', res.missingPaths);
    if (res.missingLinks.length) console.error('Missing links:', res.missingLinks);
    process.exitCode = 1;
  } else {
    console.log('OK: all README paths and links resolve.');
  }
}
