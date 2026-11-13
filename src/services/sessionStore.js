/**
 * services/sessionStore.js — encrypted "record-once login" sessions (Rung 3+).
 *
 * A recorded session is a Playwright storageState ({ cookies, origins })
 * captured from a real manual login. Sessions are stored PER MONITOR and
 * PER ROLE (e.g. an authenticated run and an anonymous control run) and
 * encrypted at rest with AES-256-GCM — they contain live credentials, so
 * plaintext must never touch the disk.
 *
 * Files:  <dataDir>/sessions/<monitorId>:<role>.session   (base64 iv.tag.ciphertext)
 *         (win32 uses '_' doubling: <monitorId>__<role>.session — ':' is not
 *          a legal filename character on NTFS)
 * Legacy: <dataDir>/sessions/<monitorId>.session          (role 'default')
 *         — still loads as the 'default' session, and is transparently
 *           migrated to the new naming on the next 'default' save.
 * Key:    SQA_SESSION_SECRET env (any passphrase) or an auto-generated key
 *         material file at <dataDir>/.session.key, stretched with scrypt
 *         using a per-install random salt persisted at <dataDir>/.session.salt.
 *         Legacy derivations (fixed 'sqa-session-salt' / raw sha256 key file)
 *         are accepted for one read, then the session is re-saved under the
 *         current key.
 *
 * Never log session contents. Only metadata (cookie count, recordedAt) is
 * exposed to the UI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_ALGO = 'aes-256-gcm';
const LEGACY_SALT = 'sqa-session-salt';
const ROLE_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const MONITOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
// ':' on POSIX; ':' is reserved on NTFS so Windows doubles an underscore.
const ROLE_SEP = process.platform === 'win32' ? '__' : ':';

/** Heuristic: does this URL/title look like a login page? Used to detect
 *  expired recorded sessions (the crawler landed on login despite cookies). */
export function looksLikeLoginUrl(url = '', title = '') {
  const text = `${url} ${title}`.toLowerCase();
  // \s is a boundary because url and title are joined with a space —
  // a login path at the END of the url must still match.
  return /\/(login|signin|sign-in|log-in|auth|authenticate|session|sso)([/?#]|\s|$)/.test(text)
    || /(sign in|log in|login|sign up|register) (to |into )?your account/.test(text)
    || /(login|sign in) page/.test(text);
}

export class SessionStore {
  constructor({ dataDir = path.join(process.cwd(), 'data'), secret = process.env.SQA_SESSION_SECRET } = {}) {
    this.dir = path.join(dataDir, 'sessions');
    this.keyPath = path.join(dataDir, '.session.key');
    this.saltPath = path.join(dataDir, '.session.salt');
    this._secret = secret;
  }

  /** Coerce a role argument (string, { role } or undefined) into a validated role. */
  _normalizeRole(roleOrOpts) {
    let role = roleOrOpts;
    if (role != null && typeof role === 'object') role = role.role;
    if (role == null || role === '') return 'default';
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
      throw new Error(`Invalid role for session storage: ${role}`);
    }
    return role;
  }

  _monitorFile(monitorId) {
    if (!MONITOR_ID_PATTERN.test(monitorId)) {
      throw new Error(`Invalid monitor id for session storage: ${monitorId}`);
    }
  }

  _file(monitorId, roleOrOpts) {
    const role = this._normalizeRole(roleOrOpts);
    this._monitorFile(monitorId);
    return path.join(this.dir, `${monitorId}${ROLE_SEP}${role}.session`);
  }

  /** Pre-roles layout: one session per monitor, always role 'default'. */
  _legacyFile(monitorId) {
    this._monitorFile(monitorId);
    return path.join(this.dir, `${monitorId}.session`);
  }

  async _readOrCreate(file, generator) {
    try {
      return (await fs.readFile(file, 'utf-8')).trim();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const generated = generator();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, generated, { mode: 0o600 });
      return generated;
    }
  }

  /** Key material: the env passphrase, or the auto-generated key file. */
  async _keyMaterial() {
    if (this._secret) return this._secret;
    return this._readOrCreate(this.keyPath, () => crypto.randomBytes(32).toString('hex'));
  }

  /** Per-install random salt, persisted next to the key file (0600). */
  _getSalt() {
    return this._readOrCreate(this.saltPath, () => crypto.randomBytes(16).toString('hex'));
  }

  /** Resolve the 32-byte key: scrypt(key material, per-install salt). */
  async _getKey() {
    if (this._key) return this._key;
    const [material, salt] = await Promise.all([this._keyMaterial(), this._getSalt()]);
    this._key = crypto.scryptSync(material, salt, 32);
    return this._key;
  }

  /**
   * Key derivations used by older versions, tried once (in order) when the
   * current key fails to decrypt — callers then re-save under the new key.
   *  1. scrypt(secret, 'sqa-session-salt', 32)   — pre-per-install-salt
   *  2. sha256(key-file contents)                — original auto-generated key
   */
  async _legacyKeys() {
    const keys = [];
    if (this._secret) {
      keys.push(crypto.scryptSync(this._secret, LEGACY_SALT, 32));
      return keys;
    }
    try {
      const material = (await fs.readFile(this.keyPath, 'utf-8')).trim();
      keys.push(crypto.scryptSync(material, LEGACY_SALT, 32));
      keys.push(crypto.createHash('sha256').update(material).digest());
    } catch { /* no key file — nothing legacy to try */ }
    return keys;
  }

  _encrypt(state, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(SESSION_ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(state), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
  }

  /** Encrypt + persist a storageState for a monitor (and role). Returns metadata. */
  async saveSession(monitorId, storageState, roleOrOpts) {
    if (!storageState || !Array.isArray(storageState.cookies)) {
      throw new Error('Invalid storageState — expected { cookies, origins }');
    }
    const role = this._normalizeRole(roleOrOpts);
    const key = await this._getKey();

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this._file(monitorId, role), this._encrypt(storageState, key));

    // The legacy file IS the 'default' session — once its replacement exists,
    // drop it so loadSession/listSessions cannot surface stale credentials.
    if (role === 'default') {
      await fs.unlink(this._legacyFile(monitorId)).catch(() => {});
    }

    const meta = this.metaFromState(storageState);
    return { ...meta, role, monitorId };
  }

  _decrypt(raw, key) {
    const [ivB64, tagB64, dataB64] = raw.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Corrupt session file');
    const decipher = crypto.createDecipheriv(SESSION_ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf-8'));
  }

  /** Decrypt + load a session, or null when none exists. Throws on tampering. */
  async loadSession(monitorId, roleOrOpts) {
    const role = this._normalizeRole(roleOrOpts);
    // Role files only hold their own role; the legacy file is role 'default'.
    const candidates = role === 'default'
      ? [this._file(monitorId, role), this._legacyFile(monitorId)]
      : [this._file(monitorId, role)];

    let raw = null;
    let file = null;
    for (const candidate of candidates) {
      try {
        raw = await fs.readFile(candidate, 'utf-8');
        file = candidate;
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (raw == null) return null;

    const key = await this._getKey();
    try {
      return this._decrypt(raw, key);
    } catch (err) {
      // Graceful migration: try each legacy derivation once; on a hit,
      // re-save under the current per-install key.
      for (const legacyKey of await this._legacyKeys()) {
        try {
          const state = this._decrypt(raw, legacyKey);
          await fs.writeFile(file, this._encrypt(state, key));
          return state;
        } catch { /* try next legacy derivation */ }
      }
      throw err;
    }
  }

  async hasSession(monitorId, roleOrOpts) {
    const role = this._normalizeRole(roleOrOpts);
    const candidates = role === 'default'
      ? [this._file(monitorId, role), this._legacyFile(monitorId)]
      : [this._file(monitorId, role)];
    for (const file of candidates) {
      try {
        await fs.access(file);
        return true;
      } catch { /* next candidate */ }
    }
    return false;
  }

  /**
   * All recorded sessions for a monitor, newest-shape first. Each entry is
   * non-sensitive metadata plus its `role` — safe for the dashboard.
   */
  async listSessions(monitorId) {
    this._monitorFile(monitorId);
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const legacy = `${monitorId}.session`;
    const prefixes = [`${monitorId}:`, `${monitorId}${ROLE_SEP}`];
    const roles = new Set();
    for (const name of names) {
      if (name === legacy) {
        roles.add('default');
        continue;
      }
      for (const prefix of prefixes) {
        if (name.startsWith(prefix) && name.endsWith('.session')) {
          const role = name.slice(prefix.length, -'.session'.length);
          if (ROLE_PATTERN.test(role)) roles.add(role);
        }
      }
    }

    const ordered = [...roles].sort((a, b) =>
      (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));

    const sessions = [];
    for (const role of ordered) {
      sessions.push({ role, ...(await this.getSessionMeta(monitorId, role)) });
    }
    return sessions;
  }

  async deleteSession(monitorId, roleOrOpts) {
    const role = this._normalizeRole(roleOrOpts);
    const candidates = role === 'default'
      ? [this._file(monitorId, role), this._legacyFile(monitorId)]
      : [this._file(monitorId, role)];
    let deleted = false;
    for (const file of candidates) {
      try {
        await fs.unlink(file);
        deleted = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return deleted;
  }

  /** Non-sensitive metadata safe for the UI/logs. */
  metaFromState(storageState) {
    const cookies = storageState?.cookies || [];
    const recordedAt = (() => {
      // Prefer the newest cookie expiry-ish timestamp; fall back to now
      return new Date().toISOString();
    })();
    return {
      exists: true,
      cookieCount: cookies.length,
      originCount: storageState?.origins?.length || 0,
      domains: [...new Set(cookies.map(c => c.domain).filter(Boolean))].slice(0, 5),
      recordedAt,
    };
  }

  async getSessionMeta(monitorId, roleOrOpts) {
    const role = this._normalizeRole(roleOrOpts);
    if (!(await this.hasSession(monitorId, role))) return { exists: false };
    try {
      const state = await this.loadSession(monitorId, role);
      return { exists: true, role, ...this.metaFromState(state) };
    } catch {
      return { exists: true, role, error: 'session file unreadable (wrong key?)' };
    }
  }

  /**
   * Build a Cookie header value for a target host/URL from a storageState —
   * used to give API contract probes the recorded session.
   *
   * `target` may be a bare hostname (legacy) or a full URL. When a URL with
   * an `http:` scheme is given, cookies flagged `secure` are skipped — they
   * would never be sent by a real browser over plaintext http. An optional
   * `opts.path` scopes cookies by their `path` attribute (RFC 6265).
   */
  cookieHeaderFor(target, storageState, opts = {}) {
    if (!target || !storageState?.cookies?.length) return null;

    let host = String(target);
    let scheme = null;
    try {
      const parsed = new URL(host);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        scheme = parsed.protocol;
        host = parsed.hostname;
      }
    } catch { /* bare hostname — keep as-is */ }

    const requestPath = typeof opts?.path === 'string' ? opts.path : null;
    const now = Date.now() / 1000;
    const parts = [];
    for (const c of storageState.cookies) {
      const domain = (c.domain || '').replace(/^\./, '');
      if (!domain || !(host === domain || host.endsWith(`.${domain}`))) continue;
      if (c.expires && c.expires > 0 && c.expires < now) continue;
      // Secure cookies must never ride over plaintext http.
      if (c.secure && scheme === 'http:') continue;
      if (requestPath && !this._pathMatch(requestPath, c.path)) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : null;
  }

  /** RFC 6265 basic path-match between a request path and a cookie path. */
  _pathMatch(requestPath, cookiePath) {
    const req = requestPath || '/';
    const cookie = cookiePath || '/';
    if (cookie === '/') return true;
    if (req === cookie) return true;
    return req.startsWith(cookie) && (cookie.endsWith('/') || req.charAt(cookie.length) === '/');
  }
}
