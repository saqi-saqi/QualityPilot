import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDue, nextRunAt, MonitorSchema, MonitorStore } from '../src/services/monitors.js';

describe('isDue', () => {
  const base = { enabled: true, intervalHours: 24 };

  it('is due when never run', () => {
    assert.equal(isDue({ ...base, lastRunAt: null }), true);
    assert.equal(isDue({ ...base, lastRunAt: undefined }), true);
  });

  it('is not due when the interval has not elapsed', () => {
    const now = Date.now();
    const monitor = { ...base, lastRunAt: new Date(now - 3600 * 1000).toISOString() }; // 1h ago
    assert.equal(isDue(monitor, now), false);
  });

  it('is due once the interval has elapsed', () => {
    const now = Date.now();
    const monitor = { ...base, lastRunAt: new Date(now - 25 * 3600 * 1000).toISOString() }; // 25h ago
    assert.equal(isDue(monitor, now), true);
  });

  it('is due exactly at the interval boundary', () => {
    const now = Date.now();
    const monitor = { ...base, lastRunAt: new Date(now - 24 * 3600 * 1000).toISOString() };
    assert.equal(isDue(monitor, now), true);
  });

  it('is never due when disabled', () => {
    const now = Date.now();
    const monitor = { enabled: false, intervalHours: 24, lastRunAt: new Date(now - 100 * 3600 * 1000).toISOString() };
    assert.equal(isDue(monitor, now), false);
  });

  it('is due when lastRunAt is unparseable', () => {
    assert.equal(isDue({ ...base, lastRunAt: 'not-a-date' }), true);
  });
});

describe('nextRunAt', () => {
  it('returns now for a never-run monitor', () => {
    const before = Date.now();
    const next = nextRunAt({ enabled: true, intervalHours: 24, lastRunAt: null });
    assert.ok(Date.parse(next) >= before);
  });

  it('adds the interval to the last run', () => {
    const last = '2026-01-01T00:00:00.000Z';
    const next = nextRunAt({ enabled: true, intervalHours: 24, lastRunAt: last });
    assert.equal(next, '2026-01-02T00:00:00.000Z');
  });

  it('returns null when disabled', () => {
    assert.equal(nextRunAt({ enabled: false, intervalHours: 24, lastRunAt: null }), null);
  });
});

describe('MonitorSchema', () => {
  const valid = {
    id: 'acme-site',
    label: 'Acme',
    url: 'https://acme.com',
    intervalHours: 12,
    options: { maxPages: 5, maxDepth: 1 },
  };

  it('accepts a valid monitor and applies defaults', () => {
    const parsed = MonitorSchema.safeParse(valid);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.enabled, true);
    assert.equal(parsed.data.onlyNewFindings, true);
    assert.equal(parsed.data.lastRunAt, null);
    assert.equal(parsed.data.lastScore, null);
  });

  it('rejects a bad url', () => {
    const parsed = MonitorSchema.safeParse({ ...valid, url: 'not a url' });
    assert.equal(parsed.success, false);
  });

  it('rejects non-http(s) url schemes (file:// can never open in a browser scan)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://acme.com', 'javascript:alert(1)', 'data:text/html,x']) {
      const parsed = MonitorSchema.safeParse({ ...valid, url });
      assert.equal(parsed.success, false, `scheme must be rejected: ${url}`);
      if (!parsed.success) {
        assert.match(parsed.error.issues[0].message, /http or https/);
      }
    }
  });

  it('accepts roles and defaults them to []', () => {
    const parsed = MonitorSchema.safeParse(valid);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.roles, []);

    const withRoles = MonitorSchema.safeParse({ ...valid, roles: ['default', 'admin-user'] });
    assert.equal(withRoles.success, true);
    assert.deepEqual(withRoles.data.roles, ['default', 'admin-user']);
  });

  it('rejects roles that fail the role charset guard', () => {
    for (const roles of [['../evil'], ['has space'], ['x'.repeat(33)], ['ok', '']]) {
      const parsed = MonitorSchema.safeParse({ ...valid, roles });
      assert.equal(parsed.success, false, `roles must be rejected: ${JSON.stringify(roles)}`);
    }
  });

  it('rejects ids with invalid characters', () => {
    const parsed = MonitorSchema.safeParse({ ...valid, id: 'has spaces!' });
    assert.equal(parsed.success, false);
  });

  it('rejects an id that is too long', () => {
    const parsed = MonitorSchema.safeParse({ ...valid, id: 'x'.repeat(65) });
    assert.equal(parsed.success, false);
  });

  it('rejects intervalHours below 1', () => {
    const parsed = MonitorSchema.safeParse({ ...valid, intervalHours: 0 });
    assert.equal(parsed.success, false);
  });

  it('rejects unknown option keys (strict)', () => {
    const parsed = MonitorSchema.safeParse({ ...valid, options: { evil: true } });
    assert.equal(parsed.success, false);
  });
});

describe('MonitorStore URL gate', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-monitors-'));
    store = new MonitorStore(dir, { useSqlite: false });
  });

  it('rejects non-http(s) monitor urls with a clear error (no DNS needed)', async () => {
    const res = await store.add({ id: 'evil', label: 'Evil', url: 'file:///etc/passwd' });
    assert.equal(res.ok, false);
    assert.match(res.error, /http or https/);
    assert.deepEqual(await store.list(), [], 'rejected monitor must not be persisted');
  });

  it('throws (→ HTTP 400) when an update tries to sneak in a blocked url', async () => {
    await assert.rejects(
      () => store.update('whatever', { url: 'file:///etc/passwd' }),
      /url: Protocol not allowed/
    );
  });

  it('applies state patches without re-validating the url (no DNS dependency)', async () => {
    // Seed an existing monitor directly so no DNS round-trip is needed.
    await fs.promises.writeFile(path.join(dir, 'monitors.json'), JSON.stringify([{
      id: 'm1', label: 'M1', url: 'https://acme.com', roles: [], options: {},
      intervalHours: 24, enabled: true, onlyNewFindings: true, webhookUrl: '',
      lastRunAt: null, lastRunId: null, lastScore: null, lastStatus: null,
    }]));
    const updated = await store.update('m1', { lastRunAt: '2026-01-01T00:00:00.000Z', lastScore: 90 });
    assert.equal(updated.lastRunAt, '2026-01-01T00:00:00.000Z');
    assert.equal(updated.url, 'https://acme.com');
  });
});
