import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReadmePaths } from '../scripts/verify-readme-paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('README path & link audit (WS3)', () => {
  it('resolves every documented repository path and local link in README.md', () => {
    const res = auditReadmePaths(REPO_ROOT);
    assert.deepEqual(res.missingPaths, [], `Missing paths in README.md: ${res.missingPaths.join(', ')}`);
    assert.deepEqual(res.missingLinks, [], `Broken links in README.md: ${res.missingLinks.join(', ')}`);
    assert.equal(res.ok, true);
    assert.ok(res.checkedPaths >= 20);
  });
});
