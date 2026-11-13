import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionStore, looksLikeLoginUrl } from '../src/services/sessionStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-sessions-'));
}

// File naming is platform-aware: ':' is not a legal NTFS filename character.
const ROLE_SEP = process.platform === 'win32' ? '__' : ':';

const sampleState = {
  cookies: [
    { name: 'sessionid', value: 'SECRET-VALUE-123', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true },
    { name: 'csrftoken', value: 'abc', domain: 'app.example.com', path: '/', expires: 9999999999 },
  ],
  origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
};

describe('SessionStore', () => {
  let store;
  let dir;

  beforeEach(() => {
    dir = tmpDir();
    store = new SessionStore({ dataDir: dir, secret: 'test-secret-passphrase' });
  });

  it('round-trips a storageState through encryption', async () => {
    await store.saveSession('m1', sampleState);
    const loaded = await store.loadSession('m1');
    assert.deepEqual(loaded, sampleState);
  });

  it('never stores cookie values in plaintext on disk', async () => {
    await store.saveSession('m1', sampleState);
    const raw = fs.readFileSync(path.join(dir, 'sessions', `m1${ROLE_SEP}default.session`), 'utf-8');
    assert.ok(!raw.includes('SECRET-VALUE-123'), 'plaintext cookie value leaked to disk!');
  });

  it('returns null when no session exists', async () => {
    assert.equal(await store.loadSession('nope'), null);
    assert.equal(await store.hasSession('nope'), false);
  });

  it('deletes sessions', async () => {
    await store.saveSession('m1', sampleState);
    assert.equal(await store.deleteSession('m1'), true);
    assert.equal(await store.hasSession('m1'), false);
    assert.equal(await store.deleteSession('m1'), false);
  });

  it('fails to decrypt a session saved with a different key', async () => {
    await store.saveSession('m1', sampleState);
    const otherStore = new SessionStore({ dataDir: dir, secret: 'a-different-secret' });
    await assert.rejects(() => otherStore.loadSession('m1'));
  });

  it('rejects invalid monitor ids (path traversal guard)', async () => {
    await assert.rejects(() => store.saveSession('../evil', sampleState));
  });

  it('rejects invalid storageState', async () => {
    await assert.rejects(() => store.saveSession('m1', { cookies: 'not-an-array' }));
  });

  it('exposes non-sensitive metadata only', async () => {
    await store.saveSession('m1', sampleState);
    const meta = await store.getSessionMeta('m1');
    assert.equal(meta.exists, true);
    assert.equal(meta.cookieCount, 2);
    assert.equal(meta.originCount, 1);
    assert.ok(!JSON.stringify(meta).includes('SECRET-VALUE-123'), 'metadata leaked cookie values');
  });

  it('works with an auto-generated key file when no secret is set', async () => {
    const store2 = new SessionStore({ dataDir: dir });
    await store2.saveSession('m2', sampleState);
    const loaded = await store2.loadSession('m2');
    assert.equal(loaded.cookies[0].name, 'sessionid');
    assert.ok(fs.existsSync(path.join(dir, '.session.key')));
  });

  it('generates and persists a per-install salt next to the key (0600 intent)', async () => {
    await store.saveSession('m1', sampleState);
    const saltPath = path.join(dir, '.session.salt');
    assert.ok(fs.existsSync(saltPath), '.session.salt was not created');
    const salt = fs.readFileSync(saltPath, 'utf-8').trim();
    assert.match(salt, /^[0-9a-f]{16,}$/, 'salt must be hex');
    // A second store with the same secret + same salt must derive the same key
    const store2 = new SessionStore({ dataDir: dir, secret: 'test-secret-passphrase' });
    const loaded = await store2.loadSession('m1');
    assert.deepEqual(loaded, sampleState);
  });

  it('builds a Cookie header for the matching host only', async () => {
    const header = store.cookieHeaderFor('app.example.com', sampleState);
    assert.ok(header.includes('sessionid=SECRET-VALUE-123'));
    assert.ok(header.includes('csrftoken=abc'));

    const wrongHost = store.cookieHeaderFor('other.com', sampleState);
    assert.equal(wrongHost, null);
  });

  it('skips secure cookies when the probe URL is http:', async () => {
    const header = store.cookieHeaderFor('http://app.example.com/page', sampleState);
    assert.ok(!header.includes('sessionid=SECRET-VALUE-123'), 'secure cookie leaked over http!');
    assert.ok(header.includes('csrftoken=abc'));
  });

  it('keeps secure cookies for https: probe URLs', async () => {
    const header = store.cookieHeaderFor('https://app.example.com/page', sampleState);
    assert.ok(header.includes('sessionid=SECRET-VALUE-123'));
    assert.ok(header.includes('csrftoken=abc'));
  });

  it('honors cookie path scoping when a request path is given', async () => {
    const state = {
      cookies: [
        { name: 'admin', value: 'yes', domain: '.example.com', path: '/admin' },
        { name: 'site', value: 'wide', domain: '.example.com', path: '/' },
      ],
    };
    const adminHeader = store.cookieHeaderFor('https://example.com/admin/settings', state, { path: '/admin/settings' });
    assert.ok(adminHeader.includes('admin=yes'));
    assert.ok(adminHeader.includes('site=wide'));

    const outside = store.cookieHeaderFor('https://example.com/public', state, { path: '/public' });
    assert.ok(!outside.includes('admin=yes'), 'admin-scoped cookie leaked outside its path');
    assert.ok(outside.includes('site=wide'));
  });
});

describe('SessionStore roles', () => {
  let store;
  let dir;
  const adminState = { cookies: [{ name: 'adminsid', value: 'ADMIN-1', domain: '.example.com', path: '/' }], origins: [] };

  beforeEach(() => {
    dir = tmpDir();
    store = new SessionStore({ dataDir: dir, secret: 'test-secret-passphrase' });
  });

  it('keeps roles isolated per monitor', async () => {
    await store.saveSession('m1', sampleState);
    await store.saveSession('m1', adminState, 'admin');

    const def = await store.loadSession('m1');
    assert.equal(def.cookies[0].name, 'sessionid');
    const admin = await store.loadSession('m1', 'admin');
    assert.equal(admin.cookies[0].value, 'ADMIN-1');

    // other monitors are unaffected
    assert.equal(await store.loadSession('m1', 'nobody'), null);
  });

  it('lists sessions with roles, default first, and role metadata', async () => {
    await store.saveSession('m1', sampleState);
    await store.saveSession('m1', adminState, 'admin');
    await store.saveSession('m1', { cookies: [{ name: 'z', value: 'z', domain: '.example.com' }] }, 'zz-last');

    const sessions = await store.listSessions('m1');
    assert.deepEqual(sessions.map(s => s.role), ['default', 'admin', 'zz-last']);
    for (const s of sessions) {
      assert.equal(s.exists, true);
      assert.equal(typeof s.cookieCount, 'number');
      assert.ok(!JSON.stringify(s).includes('SECRET-VALUE-123'), 'listSessions leaked cookie values');
    }
  });

  it('returns [] from listSessions when nothing was ever recorded', async () => {
    assert.deepEqual(await store.listSessions('ghost'), []);
  });

  it('sanitizes roles with the same traversal guard as monitor ids', async () => {
    await assert.rejects(() => store.saveSession('m1', sampleState, '../evil'));
    await assert.rejects(() => store.saveSession('m1', sampleState, 'has space'));
    await assert.rejects(() => store.saveSession('m1', sampleState, 'x'.repeat(33)));
    await assert.rejects(() => store.loadSession('m1', '../evil'));
    await assert.rejects(() => store.deleteSession('m1', '../evil'));
  });

  it('accepts { role } objects (dashboard call shape)', async () => {
    await store.saveSession('m1', adminState, { role: 'admin' });
    assert.equal(await store.hasSession('m1', { role: 'admin' }), true);
    const admin = await store.loadSession('m1', { role: 'admin' });
    assert.equal(admin.cookies[0].value, 'ADMIN-1');
    assert.equal(await store.deleteSession('m1', { role: 'admin' }), true);
    assert.equal(await store.hasSession('m1', { role: 'admin' }), false);
  });

  it('still loads legacy role-less files as the default session', async () => {
    // Simulate a pre-roles install: save, then rename the file back to the
    // legacy layout. It must load as role 'default'.
    await store.saveSession('m1', sampleState);
    fs.renameSync(
      path.join(dir, 'sessions', `m1${ROLE_SEP}default.session`),
      path.join(dir, 'sessions', 'm1.session'),
    );
    const loaded = await store.loadSession('m1');
    assert.deepEqual(loaded, sampleState);
    const sessions = await store.listSessions('m1');
    assert.deepEqual(sessions.map(s => s.role), ['default']);
  });

  it('migrates legacy fixed-salt (scrypt) sessions to the per-install key', async () => {
    // Encrypt exactly the way the pre-salt version did:
    //   key = scrypt(secret, 'sqa-session-salt', 32)
    const legacyKey = crypto.scryptSync('test-secret-passphrase', 'sqa-session-salt', 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const plaintext = Buffer.from(JSON.stringify(sampleState), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const legacyPayload = [
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', 'm1.session'), legacyPayload);

    // Loading transparently falls back to the legacy key…
    const loaded = await store.loadSession('m1');
    assert.deepEqual(loaded, sampleState);
    // …and re-saves under the new key (a second load with a fresh store
    // instance — same secret/salt — must succeed without the legacy path).
    const store2 = new SessionStore({ dataDir: dir, secret: 'test-secret-passphrase' });
    assert.deepEqual(await store2.loadSession('m1'), sampleState);
  });

  it('migrates legacy auto-generated sha256 key-file sessions', async () => {
    // Original scheme: .session.key holds random hex; key = sha256(content)
    const material = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, '.session.key'), material, { mode: 0o600 });
    const legacyKey = crypto.createHash('sha256').update(material).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const plaintext = Buffer.from(JSON.stringify(sampleState), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', 'm1.session'),
      [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.'));

    const store2 = new SessionStore({ dataDir: dir }); // no secret — key file install
    assert.deepEqual(await store2.loadSession('m1'), sampleState);
    // migrated: readable a second time (and by another instance)
    const store3 = new SessionStore({ dataDir: dir });
    assert.deepEqual(await store3.loadSession('m1'), sampleState);
  });

  it('saving the default role removes the legacy file so stale credentials cannot linger', async () => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', 'm1.session'), 'legacy-not-really-encrypted');
    await store.saveSession('m1', sampleState);
    assert.equal(fs.existsSync(path.join(dir, 'sessions', 'm1.session')), false);
    assert.deepEqual(await store.loadSession('m1'), sampleState);
  });

  it('deleting the default role also deletes a legacy file', async () => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', 'm1.session'), 'legacy');
    assert.equal(await store.deleteSession('m1'), true);
    assert.equal(fs.existsSync(path.join(dir, 'sessions', 'm1.session')), false);
  });
});

describe('looksLikeLoginUrl', () => {
  it('detects login paths', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/login'), true);
    assert.equal(looksLikeLoginUrl('https://app.com/account/signin'), true);
    assert.equal(looksLikeLoginUrl('https://app.com/sso?redirect=x'), true);
  });

  it('detects login-page titles', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/home', 'Sign in to your account'), true);
    assert.equal(looksLikeLoginUrl('', 'Login Page'), true);
  });

  it('does not flag normal pages', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/dashboard'), false);
    assert.equal(looksLikeLoginUrl('https://app.com/blog/authors'), false);
    assert.equal(looksLikeLoginUrl('https://app.com/', 'Welcome to the blog'), false);
  });
});
