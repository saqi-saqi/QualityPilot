/**
 * test/waivers.test.js — Phase 10 findings waivers with expiry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaiverFile, applyWaivers } from '../src/services/waivers.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

const makeFinding = createFindingFactory();
const hsts = (pageUrl = 'http://localhost:3000') => makeFinding({
  title: 'Missing or invalid strict-transport-security header',
  severity: 'high', category: 'network', ruleId: 'header-strict-transport-security', pageUrl,
});
const csp = (pageUrl = 'http://localhost:3000') => makeFinding({
  title: 'Missing or invalid content-security-policy header',
  severity: 'high', category: 'network', ruleId: 'header-content-security-policy', pageUrl,
});

describe('parseWaiverFile', () => {
  it('parses valid waivers', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({
      waivers: [{ ruleId: 'header-strict-transport-security', reason: 'localhost only', pageUrl: 'http://localhost:3000', expiresAt: '2027-12-31' }],
    }));
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].ruleId, 'header-strict-transport-security');
  });

  it('requires a written reason', () => {
    assert.throws(
      () => parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x' }] })),
      /"reason" is required/,
    );
  });

  it('rejects invalid expiry dates', () => {
    assert.throws(
      () => parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x', reason: 'r', expiresAt: 'soon' }] })),
      /expiresAt/,
    );
  });

  it('rejects files without a waivers array', () => {
    assert.throws(() => parseWaiverFile('{}'), /"waivers" array/);
    assert.throws(() => parseWaiverFile('not json at all'), /not valid JSON/);
  });
});

describe('applyWaivers', () => {
  const T = { today: new Date('2026-11-17T00:00:00Z') };

  it('suppresses matching findings and keeps the rest', () => {
    const { kept, waived } = applyWaivers(
      [hsts(), csp()],
      [{ ruleId: 'header-strict-transport-security', reason: 'localhost only' }],
      T,
    );
    assert.equal(waived.length, 1);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].ruleId, 'header-content-security-policy');
  });

  it('honors exact pageUrl matching', () => {
    const findings = [hsts('http://localhost:3000'), hsts('http://localhost:3000/admin')];
    const { kept, waived } = applyWaivers(
      findings,
      [{ ruleId: 'header-strict-transport-security', pageUrl: 'http://localhost:3000', reason: 'root page only' }],
      T,
    );
    assert.equal(waived.length, 1);
    assert.equal(kept.length, 1);
  });

  it('supports prefix matching with a trailing *', () => {
    const findings = [hsts('http://localhost:3000'), hsts('http://localhost:3000/admin'), hsts('http://localhost:3000/admin/config')];
    const { waived } = applyWaivers(
      findings,
      [{ ruleId: 'header-strict-transport-security', pageUrl: 'http://localhost:3000/admin*', reason: 'admin paths only' }],
      T,
    );
    assert.equal(waived.length, 2);
  });

  it('expired waivers suppress nothing but warn loudly when they would have matched', () => {
    const { kept, waived } = applyWaivers(
      [hsts()],
      [{ ruleId: 'header-strict-transport-security', reason: 'stale waiver', expiresAt: '2026-01-01' }],
      T,
    );
    assert.equal(waived.length, 0, 'expired waiver matches nothing');
    assert.equal(kept.length, 1, 'the finding surfaces again');
  });

  it('produces warnings for expired waivers that would have matched', () => {
    const { warnings } = applyWaivers(
      [hsts()],
      [{ ruleId: 'header-strict-transport-security', reason: 'stale waiver', expiresAt: '2026-01-01' }],
      { today: new Date('2026-11-17T00:00:00Z') },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EXPIRED WAIVER/);
    assert.match(warnings[0], /header-strict-transport-security/);
  });

  it('unexpired waivers still apply', () => {
    const { waived } = applyWaivers(
      [hsts()],
      [{ ruleId: 'header-strict-transport-security', reason: 'future waiver', expiresAt: '2027-01-01' }],
      { today: new Date('2026-11-17T00:00:00Z') },
    );
    assert.equal(waived.length, 1);
  });

  it('does not mutate inputs', () => {
    const finding = hsts();
    const before = JSON.parse(JSON.stringify(finding));
    applyWaivers([finding], [{ ruleId: 'header-strict-transport-security', reason: 'r' }], T);
    assert.deepEqual(JSON.parse(JSON.stringify(finding)), before);
  });
});
