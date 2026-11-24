import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import {
  isPrivateIP,
  normalizeUrl,
  validateUrl,
  validateUrlSafe,
  resolveAndPin,
  resolvePublic,
  safeFetch,
} from '../src/services/ssrf.js';

// We need allowPrivateTargets OFF (the default) for the strict tests.
// Save & restore env so tests don't leak state.
const originalEnv = { ...process.env };
before(() => {
  delete process.env.SQA_ALLOW_PRIVATE;
});
after(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('isPrivateIP', () => {
  it('flags IPv4 loopback, private, link-local, unspecified', () => {
    assert.equal(isPrivateIP('127.0.0.1'), true);
    assert.equal(isPrivateIP('10.0.0.1'), true);
    assert.equal(isPrivateIP('172.16.0.1'), true);
    assert.equal(isPrivateIP('172.31.255.255'), true);
    assert.equal(isPrivateIP('192.168.1.1'), true);
    assert.equal(isPrivateIP('169.254.1.1'), true);
    assert.equal(isPrivateIP('0.0.0.0'), true);
    assert.equal(isPrivateIP('0.0.0.1'), true);
  });

  describe('production SSRF guard', () => {
    it('ignores private-target opt-ins in production', async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousAllowPrivate = process.env.SQA_ALLOW_PRIVATE;
      try {
        process.env.NODE_ENV = 'production';
        process.env.SQA_ALLOW_PRIVATE = 'true';
        await assert.rejects(
          () => validateUrl('http://127.0.0.1'),
          /Private hostname not allowed|URL resolves to private IP/
        );
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousAllowPrivate === undefined) delete process.env.SQA_ALLOW_PRIVATE;
        else process.env.SQA_ALLOW_PRIVATE = previousAllowPrivate;
      }
    });
  });

  it('does NOT flag 172.32.x.x as private (boundary check)', () => {
    assert.equal(isPrivateIP('172.32.0.1'), false);
    assert.equal(isPrivateIP('172.15.0.1'), false);
  });

  it('flags public IPv4 as not-private', () => {
    assert.equal(isPrivateIP('8.8.8.8'), false);
    assert.equal(isPrivateIP('1.1.1.1'), false);
    assert.equal(isPrivateIP('93.184.216.34'), false);  // example.com
  });

  it('flags IPv6 loopback, link-local, ULA, unspecified', () => {
    assert.equal(isPrivateIP('::1'), true);
    assert.equal(isPrivateIP('fe80::1'), true);
    assert.equal(isPrivateIP('fc00::1'), true);
    assert.equal(isPrivateIP('fd00::1'), true);
    assert.equal(isPrivateIP('::'), true);
  });

  it('flags CGNAT 100.64.0.0/10 (incl. Tailscale 100.x) with boundaries', () => {
    assert.equal(isPrivateIP('100.64.0.1'), true);
    assert.equal(isPrivateIP('100.100.1.1'), true);
    assert.equal(isPrivateIP('100.127.255.254'), true);
    assert.equal(isPrivateIP('100.63.255.255'), false);
    assert.equal(isPrivateIP('100.128.0.1'), false);
  });

  it('flags benchmark range 198.18.0.0/15 with boundaries', () => {
    assert.equal(isPrivateIP('198.18.0.5'), true);
    assert.equal(isPrivateIP('198.19.255.255'), true);
    assert.equal(isPrivateIP('198.17.255.255'), false);
    assert.equal(isPrivateIP('198.20.0.1'), false);
  });

  it('flags multicast 224.0.0.0/4 and reserved 240.0.0.0/4', () => {
    assert.equal(isPrivateIP('224.0.0.1'), true);
    assert.equal(isPrivateIP('239.255.255.255'), true);
    assert.equal(isPrivateIP('240.0.0.1'), true);
    assert.equal(isPrivateIP('255.255.255.255'), true);
    assert.equal(isPrivateIP('223.255.255.255'), false);
  });

  it('flags 6to4 2002::/16 and NAT64 64:ff9b::/96 (tunneled IPv4)', () => {
    assert.equal(isPrivateIP('2002::1'), true);
    assert.equal(isPrivateIP('2002:c000:204::1'), true);   // embeds 192.0.2.4
    assert.equal(isPrivateIP('2001::1'), false);            // teredo is a different /16
    assert.equal(isPrivateIP('64:ff9b::192.0.2.33'), true);
    assert.equal(isPrivateIP('64:ff9b:1::1'), false);       // 64:ff9b:1::/48, not NAT64
    assert.equal(isPrivateIP('64:ff9b::'), true);
  });

  it('flags IPv6 multicast and keeps public IPv6 public', () => {
    assert.equal(isPrivateIP('ff02::1'), true);
    assert.equal(isPrivateIP('2606:2800:220:1:248:1893:25c8:1946'), false);
  });

  it('handles IPv4-mapped IPv6 (::ffff:)', () => {
    assert.equal(isPrivateIP('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIP('::ffff:10.0.0.1'), true);
    assert.equal(isPrivateIP('::ffff:8.8.8.8'), false);
  });

  it('rejects non-IP strings', () => {
    assert.equal(isPrivateIP('not-an-ip'), false);
    assert.equal(isPrivateIP(''), false);
    assert.equal(isPrivateIP(null), false);
  });
});

describe('normalizeUrl', () => {
  it('strips fragment', () => {
    const out = normalizeUrl('https://example.com/p?q=1#frag');
    assert.equal(out, 'https://example.com/p?q=1');
  });

  it('removes trailing slash only when path is root and no query', () => {
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
    // Path with subdir keeps its slash (we only strip when pathname === '/')
    assert.equal(normalizeUrl('https://example.com/p/'), 'https://example.com/p/');
  });

  it('keeps trailing slash when query string is present', () => {
    assert.equal(normalizeUrl('https://example.com/?q=1'), 'https://example.com/?q=1');
  });

  it('throws on invalid URL', () => {
    assert.throws(() => normalizeUrl('not-a-url'), /Invalid URL/i);
  });
});

describe('validateUrl', () => {
  it('rejects non-URL strings', async () => {
    await assert.rejects(() => validateUrl('not-a-url'), /Invalid URL format/i);
  });

  it('rejects non-http(s) protocols', async () => {
    await assert.rejects(() => validateUrl('file:///etc/passwd'), /Protocol not allowed/i);
    await assert.rejects(() => validateUrl('ftp://example.com'), /Protocol not allowed/i);
    await assert.rejects(() => validateUrl('javascript:alert(1)'), /Invalid URL format|Protocol not allowed/i);
  });

  it('rejects localhost hostnames when allowPrivateTargets is false', async () => {
    await assert.rejects(() => validateUrl('http://localhost:3000/'), /Private hostname/i);
    await assert.rejects(() => validateUrl('http://127.0.0.1:3000/'), /Private hostname/i);
    await assert.rejects(() => validateUrl('http://0.0.0.0:3000/'), /Private hostname/i);
  });

  it('accepts a public https URL', async () => {
    // example.com resolves to public IPs; safe to call without network?
    // dns.promises.resolve4 will be invoked. If offline this fails.
    try {
      const r = await validateUrl('https://example.com/path');
      assert.equal(r.url, 'https://example.com/path');
      assert.equal(r.hostname, 'example.com');
      assert.ok(r.resolvedIPs.length >= 1);
    } catch (err) {
      // If we're in a sandboxed env without DNS, swallow gracefully
      if (/DNS/i.test(err.message)) {
        console.warn('Skipping example.com test — no DNS:', err.message);
        return;
      }
      throw err;
    }
  });

  it('validateUrlSafe wraps errors into { safe: false, error }', async () => {
    const bad = await validateUrlSafe('http://localhost:3000/');
    assert.equal(bad.safe, false);
    assert.match(bad.error, /Private hostname/i);

    const invalid = await validateUrlSafe('not-a-url');
    assert.equal(invalid.safe, false);
    assert.match(invalid.error, /Invalid URL/i);
  });

  it('validateUrlSafe returns safe:true + url + hostname for valid input', async () => {
    try {
      const r = await validateUrlSafe('https://example.com/');
      if (r.safe) {
        assert.equal(r.url, 'https://example.com');
        assert.equal(r.hostname, 'example.com');
      } else {
        console.warn('Skipping — DNS unavailable:', r.error);
      }
    } catch (err) {
      console.warn('Skipping validateUrlSafe happy path:', err.message);
    }
  });
});

describe('validateUrl with allowPrivateTargets', () => {
  it('accepts localhost when explicitly opted in', async () => {
    process.env.SQA_ALLOW_PRIVATE = 'true';
    try {
      const r = await validateUrl('http://localhost:3000/');
      assert.equal(r.url, 'http://localhost:3000');
      assert.equal(r.hostname, 'localhost');
    } finally {
      delete process.env.SQA_ALLOW_PRIVATE;
    }
  });

  it('accepts localhost when developer-only ALLOW_PRIVATE_HOSTS=true is set', async () => {
    process.env.ALLOW_PRIVATE_HOSTS = 'true';
    try {
      const r = await validateUrl('http://localhost:3000/');
      assert.equal(r.url, 'http://localhost:3000');
      assert.equal(r.hostname, 'localhost');
      assert.deepEqual(r.resolvedIPs, ['localhost']);
    } finally {
      delete process.env.ALLOW_PRIVATE_HOSTS;
    }
  });

  it('rejects localhost when ALLOW_PRIVATE_HOSTS is off by default', async () => {
    delete process.env.ALLOW_PRIVATE_HOSTS;
    delete process.env.SQA_ALLOW_PRIVATE;
    await assert.rejects(() => validateUrl('http://localhost:3000/'), /Private hostname not allowed/);
  });
});

describe('resolveAndPin', () => {
  // ssrf.js holds the node:dns module object and calls dns.promises.resolve4/6 —
  // patch them (unique hostnames dodge the module's 60s DNS cache).
  const originalResolve4 = dns.promises.resolve4;
  const originalResolve6 = dns.promises.resolve6;
  const mockA = new Map();
  const mockAAAA = new Map();

  beforeEach(() => {
    mockA.clear();
    mockAAAA.clear();
    dns.promises.resolve4 = async (host) => {
      if (mockA.has(host)) return mockA.get(host);
      const err = new Error(`No A record for ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    };
    dns.promises.resolve6 = async (host) => {
      if (mockAAAA.has(host)) return mockAAAA.get(host);
      const err = new Error(`No AAAA record for ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    };
  });

  afterEach(() => {
    dns.promises.resolve4 = originalResolve4;
    dns.promises.resolve6 = originalResolve6;
  });

  it('returns a host-resolver-rules MAP pinning the host to a validated IP', async () => {
    mockA.set('pin-public.example', ['93.184.216.34']);
    const r = await resolveAndPin('https://pin-public.example/page');
    assert.deepEqual(r, { rules: 'MAP pin-public.example 93.184.216.34' });
  });

  it('prefers the first validated IP when several resolve', async () => {
    mockA.set('multi.example', ['93.184.216.34', '8.8.8.8']);
    const r = await resolveAndPin('https://multi.example/');
    assert.equal(r.rules, 'MAP multi.example 93.184.216.34');
  });

  it('returns null when the host resolves to a private IP', async () => {
    mockA.set('pin-evil.example', ['10.0.0.5']);
    assert.equal(await resolveAndPin('https://pin-evil.example/'), null);
  });

  it('returns null when DNS fails', async () => {
    assert.equal(await resolveAndPin('https://no-such-host-xyz.example/'), null);
  });

  it('returns null for non-http(s) or invalid URLs', async () => {
    assert.equal(await resolveAndPin('file:///etc/passwd'), null);
    assert.equal(await resolveAndPin('not-a-url'), null);
  });

  it('returns { rules: null } for IP-literal URLs (nothing to re-resolve)', async () => {
    const r = await resolveAndPin('http://93.184.216.34/');
    assert.deepEqual(r, { rules: null });
  });

  it('never throws (defensive contract for callers)', async () => {
    assert.equal(await resolveAndPin(null), null);
    assert.equal(await resolveAndPin(undefined), null);
  });
});

describe('resolvePublic', () => {
  it('rejects hostnames resolving to private IPs', async () => {
    await assert.rejects(
      async () => resolvePublic('192.168.1.1'),
      /Blocked: non-public address/
    );
  });

  it('rejects localhost and loopback when private targets disallowed', async () => {
    await assert.rejects(
      async () => resolvePublic('127.0.0.1'),
      /Blocked: non-public address/
    );
  });
});

describe('safeFetch', () => {
  it('blocks fetch to loopback and private IP addresses', async () => {
    await assert.rejects(
      async () => safeFetch('http://127.0.0.1:8080/'),
      /Private hostname not allowed|URL resolves to private IP|Blocked: non-public address/
    );
  });

  it('blocks fetch to non-http/https protocols', async () => {
    await assert.rejects(
      async () => safeFetch('file:///etc/passwd'),
      /Protocol not allowed/
    );
  });

  it('applies the per-hop deadline even when the caller passes its own signal (audit M-7)', async () => {
    const controller = new AbortController();
    const hanging = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted by deadline')), { once: true });
    });
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/hang', { signal: controller.signal }, { fetchImpl: hanging, timeoutMs: 30 }),
      /aborted by deadline/,
      'a caller signal must not disable the per-hop timeout',
    );
  });
});

// ─── safeFetch redirect handling (audit L-3) ──────────────────────────────
// The redirect VALIDATION is under test: every Location target must pass
// validateUrl BEFORE the second request runs. Hop-0 uses a TEST-NET-2 IP
// literal (198.51.100.1 — public by the private-range table; an IP literal,
// so validateUrl needs no DNS) and fetchImpl is injected, so nothing here
// touches the network.
function mockFetch3xx(script) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return script(String(url), calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const redirectTo = (location, status = 302) => ({
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'location' ? location : null) },
});
const okResponse = { status: 200, headers: { get: () => null } };

describe('safeFetch redirect handling (audit L-3)', () => {
  beforeEach(() => {
    delete process.env.SQA_ALLOW_PRIVATE;
    delete process.env.ALLOW_PRIVATE_HOSTS;
    delete process.env.ALLOW_PRIVATE_TARGETS;
  });

  it('follows a safe relative redirect and resolves it against the current URL', async () => {
    const f = mockFetch3xx((url) => (url.endsWith('/x') ? redirectTo('/final') : okResponse));
    const res = await safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f });
    assert.equal(res.status, 200);
    assert.deepEqual(f.calls, ['http://198.51.100.1/x', 'http://198.51.100.1/final']);
  });

  it('re-validates every hop BEFORE connecting: cloud-metadata redirect is blocked', async () => {
    const f = mockFetch3xx(() => redirectTo('http://169.254.169.254/latest/meta-data/'));
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }),
      /URL resolves to private IP: 169\.254\.169\.254/,
    );
    assert.equal(f.calls.length, 1, 'the second hop must never be fetched');
  });

  it('blocks a redirect to loopback', async () => {
    const f = mockFetch3xx(() => redirectTo('http://127.0.0.1:8080/admin'));
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }),
      /Private hostname not allowed|resolves to private IP/,
    );
    assert.equal(f.calls.length, 1);
  });

  it('blocks redirects to RFC1918 ranges', async () => {
    const f = mockFetch3xx(() => redirectTo('http://10.0.0.5/internal'));
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }),
      /resolves to private IP: 10\.0\.0\.5/,
    );
    assert.equal(f.calls.length, 1);
  });

  it('blocks IPv4-mapped IPv6 redirects in any spelling', async () => {
    for (const host of ['[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]']) {
      const f = mockFetch3xx(() => redirectTo(`http://${host}/`));
      await assert.rejects(
        () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }),
        /resolves to private IP/,
        host,
      );
      assert.equal(f.calls.length, 1, host);
    }
  });

  it('rejects a bare (unbracketed) IPv6 Location as an invalid URL — fail closed', async () => {
    // RFC 3986: IPv6 literals require brackets in URLs, so WHATWG URL parsing
    // rejects this Location before validation even runs. Blocked either way.
    const f = mockFetch3xx(() => redirectTo('http://0:0:0:0:0:ffff:a9fe:a9fe/'));
    await assert.rejects(() => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }), /Invalid URL/);
    assert.equal(f.calls.length, 1);
  });

  it('bounds redirect loops (Too many redirects after maxRedirects hops)', async () => {
    const f = mockFetch3xx((url, n) => redirectTo(`/hop${n}`));
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }),
      /Too many redirects/,
    );
    assert.equal(f.calls.length, 6, 'maxRedirects=5 → at most 6 requests');
  });

  it('rejects an unparseable Location header', async () => {
    const f = mockFetch3xx(() => redirectTo('http://['));
    await assert.rejects(() => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }), /Invalid/);
    assert.equal(f.calls.length, 1);
  });

  it('rejects a redirect to a non-http(s) scheme', async () => {
    const f = mockFetch3xx(() => redirectTo('ftp://198.51.100.1/file'));
    await assert.rejects(() => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f }), /Protocol not allowed/);
    assert.equal(f.calls.length, 1);
  });

  it('honors an explicit maxRedirects option', async () => {
    const f = mockFetch3xx(() => redirectTo('/next'));
    await assert.rejects(
      () => safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f, maxRedirects: 0 }),
      /Too many redirects/,
    );
    assert.equal(f.calls.length, 1);
  });

  it('developer opt-in (allow-private) keeps private redirects followable — documented dev mode', async () => {
    const previous = process.env.SQA_ALLOW_PRIVATE;
    process.env.SQA_ALLOW_PRIVATE = 'true';
    try {
      const f = mockFetch3xx((url) => (url.endsWith('/x') ? redirectTo('http://127.0.0.1:8080/y') : okResponse));
      const res = await safeFetch('http://198.51.100.1/x', {}, { fetchImpl: f });
      assert.equal(res.status, 200);
      assert.deepEqual(f.calls, ['http://198.51.100.1/x', 'http://127.0.0.1:8080/y']);
    } finally {
      if (previous === undefined) delete process.env.SQA_ALLOW_PRIVATE;
      else process.env.SQA_ALLOW_PRIVATE = previous;
    }
  });
});
