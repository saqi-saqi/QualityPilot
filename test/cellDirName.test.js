/**
 * test/cellDirName.test.js — regression: matrix cell ids contain ':' (illegal
 * in NTFS directory names). Evidence paths built from a raw cell id made every
 * browser cell fail with ENOENT on Windows (2026-11-16 Juice Shop recall run:
 * 2–3 of 4 cells failed, a11y/perf/visual never executed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cellDirName } = await import(
  pathToFileURL(path.join(root, 'src', 'matrix', 'matrixRunner.js')).href
);

describe('cellDirName (Windows-safe cell evidence paths)', () => {
  it('strips colons from browser:viewport:role cell ids', () => {
    assert.equal(cellDirName('chromium::anon'), 'chromium--anon');
    assert.equal(cellDirName('chromium:desktop:anon'), 'chromium-desktop-anon');
    assert.equal(cellDirName('firefox:mobile:admin'), 'firefox-mobile-admin');
  });

  it('leaves ids without colons untouched and tolerates non-string input', () => {
    assert.equal(cellDirName('plain'), 'plain');
    assert.equal(cellDirName(42), '42');
    assert.equal(cellDirName(null), 'null');
  });

  it('produces names that are legal NTFS path components', () => {
    for (const id of ['chromium::anon', 'chromium:desktop:anon', 'webkit:mobile:anon']) {
      const name = cellDirName(id);
      assert.doesNotMatch(name, /[:*?"<>|]/);
    }
  });
});
