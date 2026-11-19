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

describe('waiver scope and identity (audit H-1/M-3/M-7/M-8/L-2 regressions)', () => {
  const T = { today: new Date('2026-11-19T00:00:00Z') };
  const authzFinding = (over = {}) => makeFinding({
    title: 'Admin endpoint reachable anonymously', severity: 'high', category: 'network',
    ruleId: 'api-authz-missing-role-check', pageUrl: 'https://shop.test/api/admin/users', ...over,
  });

  it('rejects unknown keys instead of silently widening the waiver', () => {
    assert.throws(
      () => parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x', reason: 'r', rolez: 'admin' }] })),
      /unknown key "rolez"/,
    );
  });

  it('accepts "role" as sugar for a single-entry scope', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x', reason: 'r', role: 'admin' }] }));
    assert.deepEqual(waivers[0].roles, ['admin']);
  });

  it('a blank pageUrl is an error, not a silent global waiver', () => {
    assert.throws(
      () => parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x', reason: 'r', pageUrl: '   ' }] })),
      /pageUrl/,
    );
  });

  it('a role-scoped waiver never suppresses the anonymous finding', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'api-authz-missing-role-check', pageUrl: 'https://shop.test/api/admin/users', role: 'admin', reason: 'verified for admin', expiresAt: '2099-01-01' },
    ] }));
    const admin = applyWaivers([authzFinding({ roles: ['admin'] })], waivers, T);
    const anon = applyWaivers([authzFinding({ roles: ['anon'] })], waivers, T);
    assert.equal(admin.waived.length, 1);
    assert.equal(anon.waived.length, 0, 'the anonymous finding must stay live');
  });

  it('a role-scoped waiver never suppresses findings without role info', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'api-authz-missing-role-check', role: 'admin', reason: 'r' },
    ] }));
    assert.equal(applyWaivers([authzFinding()], waivers, T).waived.length, 0,
      'fail-safe when the scan context is unknown');
  });

  it('a merged finding observed in more roles than the waiver covers stays live', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r1', role: 'admin', reason: 'r' },
    ] }));
    const merged = authzFinding({ ruleId: 'r1', roles: ['anon', 'admin'] });
    assert.equal(applyWaivers([merged], waivers, T).waived.length, 0);
  });

  it('a method-scoped waiver does not cover another method', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r2', pageUrl: 'https://shop.test/api/order', method: 'GET', reason: 'r' },
    ] }));
    const post = authzFinding({ ruleId: 'r2', pageUrl: 'https://shop.test/api/order', method: 'POST' });
    assert.equal(applyWaivers([post], waivers, T).waived.length, 0);
  });

  it('a selector-scoped waiver covers only that element', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'button-name', pageUrl: 'https://shop.test/', selector: '#cancel', reason: 'r' },
    ] }));
    const other = authzFinding({ ruleId: 'button-name', pageUrl: 'https://shop.test/', selector: '#delete' });
    const same = authzFinding({ ruleId: 'button-name', pageUrl: 'https://shop.test/', selector: '#cancel' });
    assert.equal(applyWaivers([other], waivers, T).waived.length, 0);
    assert.equal(applyWaivers([same], waivers, T).waived.length, 1);
  });

  it('a path-prefix scope cannot cross the origin', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r3', pageUrl: 'https://shop.test*', reason: 'whole site' },
    ] }));
    const foreign = authzFinding({ ruleId: 'r3', pageUrl: 'https://shop.test.attacker.example/steal' });
    assert.equal(applyWaivers([foreign], waivers, T).waived.length, 0);
  });

  it('a path-prefix scope respects segment boundaries', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r4', pageUrl: 'https://shop.test/account*', reason: 'account area' },
    ] }));
    const within = authzFinding({ ruleId: 'r4', pageUrl: 'https://shop.test/account/settings' });
    const sibling = authzFinding({ ruleId: 'r4', pageUrl: 'https://shop.test/account-deletion' });
    assert.equal(applyWaivers([within], waivers, T).waived.length, 1);
    assert.equal(applyWaivers([sibling], waivers, T).waived.length, 0);
  });

  it('treats default ports, trailing slashes, host case and queries as the same URL', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r5', pageUrl: 'https://SHOP.test/cart/', reason: 'r' },
    ] }));
    for (const url of ['https://shop.test:443/cart', 'https://shop.test/cart/', 'https://shop.test/cart?utm=1']) {
      assert.equal(applyWaivers([authzFinding({ ruleId: 'r5', pageUrl: url })], waivers, T).waived.length, 1, url);
    }
  });

  it('expiresAt covers the whole stated day (UTC), inclusively', () => {
    const { waivers } = parseWaiverFile(JSON.stringify({ waivers: [
      { ruleId: 'r6', reason: 'r', expiresAt: '2026-12-31' },
    ] }));
    const lastMillisecond = applyWaivers([authzFinding({ ruleId: 'r6' })], waivers, { today: new Date('2026-12-31T23:59:59.999Z') });
    const nextDay = applyWaivers([authzFinding({ ruleId: 'r6' })], waivers, { today: new Date('2027-01-01T00:00:00.000Z') });
    assert.equal(lastMillisecond.waived.length, 1, 'still suppressed at the end of the stated day');
    assert.equal(nextDay.waived.length, 0, 'and expired one millisecond later');
  });

  it('rejects non-ISO and impossible expiry dates Date.parse would accept', () => {
    for (const bad of ['12/31/2026', '2026', '2026-02-31']) {
      assert.throws(
        () => parseWaiverFile(JSON.stringify({ waivers: [{ ruleId: 'x', reason: 'r', expiresAt: bad }] })),
        /expiresAt/,
        bad,
      );
    }
  });

  it('rejects duplicate waivers with the same ruleId and scope', () => {
    assert.throws(
      () => parseWaiverFile(JSON.stringify({ waivers: [
        { ruleId: 'x', reason: 'first' },
        { ruleId: 'x', reason: 'second' },
      ] })),
      /duplicates waivers\[0\]/,
    );
  });
});
