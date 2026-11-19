import dns from 'node:dns';
import { URL } from 'node:url';
import net from 'node:net';
import { config } from '../utils/config.js';
import { Agent, fetch as undiciFetch } from 'undici';

const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 60 * 1000;

/**
 * Expand an IPv6 address (including an embedded dotted-quad tail, e.g.
 * "64:ff9b::192.0.2.33") into eight 16-bit groups, or null when the input
 * is not a plain IPv6 literal.
 */
function expandIPv6(ip) {
  let addr = String(ip).toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  if (addr.includes('%')) return null; // zone id — not a routable literal
  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (parts) => {
    const groups = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes('.')) {
        // An embedded IPv4 tail is only legal as the final group.
        if (i !== parts.length - 1) return null;
        const quads = part.split('.');
        if (quads.length !== 4) return null;
        const bytes = quads.map((q) => (/^\d{1,3}$/.test(q) ? Number(q) : NaN));
        if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
        groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(parseInt(part, 16));
      }
    }
    return groups;
  };

  if (halves.length === 2) {
    const head = halves[0] ? parseGroups(halves[0].split(':')) : [];
    const tail = halves[1] ? parseGroups(halves[1].split(':')) : [];
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill(0), ...tail];
  }
  const groups = parseGroups(addr.split(':'));
  return groups && groups.length === 8 ? groups : null;
}

function isPrivateIPv4(checkIp) {
  const parts = checkIp.split('.').map(part => parseInt(part, 10));
  const [a, b, c, d] = parts;

  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 (unspecified)
  if (a === 0) return true;
  // 100.64.0.0/10 (CGNAT / carrier-grade NAT — also Tailscale 100.x)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 (benchmark / inter-network device testing)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved, incl. broadcast)
  if (a >= 224) return true;

  return false;
}

export function isPrivateIP(ip) {
  if (!net.isIP(ip)) return false;
  const value = String(ip);
  if (net.isIPv4(value)) return isPrivateIPv4(value);

  const groups = expandIPv6(value);
  if (!groups) return false;

  // IPv4-mapped ::ffff:0:0/96 — in ANY spelling. Only the dotted form
  // ("::ffff:127.0.0.1") used to be handled; the hex forms ("::ffff:7f00:1",
  // "0:0:0:0:0:ffff:a9fe:a9fe" — the cloud metadata address) fell through
  // and were treated as public.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0
      && groups[4] === 0 && groups[5] === 0xffff) {
    return isPrivateIPv4(`${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`);
  }

  if (groups.every((g) => g === 0)) return true;                                 // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;  // ::1 loopback
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if (first === 0x2002) return true;              // 2002::/16 6to4 (tunnels IPv4)
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return true; // 64:ff9b::/96 NAT64
  if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  return false;
}

/**
 * Developer-only switch check: permits private/localhost targets.
 * Off by default. Fine on your local machine, but NEVER turn on for a public service.
 */
function isPrivateTargetAllowed() {
  return Boolean(config.allowPrivateTargets || config.allowPrivateHosts);
}

export function normalizeUrl(urlString) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch (e) {
    throw new Error('Invalid URL');
  }

  // Remove fragment
  urlObj.hash = '';

  let normalized = urlObj.toString();
  
  // Remove trailing slash if path is just '/'
  if (normalized.endsWith('/') && urlObj.pathname === '/' && !urlObj.search) {
      normalized = normalized.slice(0, -1);
  }
  
  return normalized;
}

export async function validateUrl(urlString) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch (e) {
    throw new Error('Invalid URL format');
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('Protocol not allowed');
  }

  // URL.hostname keeps IPv6 brackets ("[::1]") — strip them so the literal
  // reaches the IP-literal / private-range checks below instead of failing
  // DNS resolution (bracketed strings are not valid DNS names).
  const hostname = urlObj.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const localDemoHostnames = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

  // Developer-only switch (ALLOW_PRIVATE_HOSTS=true, SQA_ALLOW_PRIVATE=true):
  // Off by default. Fine on your local machine, but NEVER turn on for a public service.
  const allowPrivate = isPrivateTargetAllowed();

  // String checks
  if (!allowPrivate && localDemoHostnames.has(hostname)) {
    throw new Error('Private hostname not allowed');
  }

  // Avoid external-DNS dependency when the explicitly opt-in development
  // setting is being used for the bundled localhost demo.
  if (allowPrivate && localDemoHostnames.has(hostname)) {
    return { url: normalizeUrl(urlString), hostname, resolvedIPs: [hostname] };
  }

  let resolvedIPs = [];
  
  const cachedDns = dnsCache.get(hostname);
  if (cachedDns && (Date.now() - cachedDns.timestamp < DNS_CACHE_TTL_MS)) {
    resolvedIPs = cachedDns.resolvedIPs;
  } else if (net.isIP(hostname)) {
    resolvedIPs = [hostname];
  } else {
    try {
      const [ipv4s, ipv6s] = await Promise.allSettled([
        dns.promises.resolve4(hostname),
        dns.promises.resolve6(hostname)
      ]);
      
      if (ipv4s.status === 'fulfilled') resolvedIPs.push(...ipv4s.value);
      if (ipv6s.status === 'fulfilled') resolvedIPs.push(...ipv6s.value);
      
      if (resolvedIPs.length === 0) {
        throw new Error('DNS resolution failed to find any IP addresses');
      }
      dnsCache.set(hostname, { resolvedIPs, timestamp: Date.now() });
    } catch (err) {
      throw new Error(`DNS resolution failed: ${err.message}`);
    }
  }

  for (const ip of resolvedIPs) {
    if (!allowPrivate && isPrivateIP(ip)) {
      throw new Error(`URL resolves to private IP: ${ip}`);
    }
  }

  const normalizedUrl = normalizeUrl(urlString);

  return { url: normalizedUrl, hostname, resolvedIPs };
}

export async function validateUrlSafe(urlString) {
  try {
    const result = await validateUrl(urlString);
    return { safe: true, ...result };
  } catch (err) {
    return { safe: false, error: err.message };
  }
}

/**
 * Resolve + pin a validated URL for headless browsing.
 *
 * DNS rebinding: validateUrl() and the browser's own DNS lookup are two
 * separate resolutions — an attacker can answer the first with a public IP
 * and the second with an internal one. resolveAndPin() runs the same
 * validation, then returns a Chromium --host-resolver-rules string that
 * pins the hostname to the validated IP, so the browser cannot re-resolve:
 *
 *   const { rules } = await ssrf.resolveAndPin(url);   // "MAP example.com 93.184.216.34"
 *   browser.launch({ args: rules ? [`--host-resolver-rules=${rules}`] : [] });
 *
 * Returns `{ rules: string|null }` — rules is null when there is nothing to
 * pin (the URL is already an IP literal, or the dev opt-in demo hostname).
 * Returns `null` when validation fails. Never throws.
 */
export async function resolveAndPin(urlString) {
  try {
    const urlObj = new URL(urlString);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return null;

    const validated = await validateUrl(urlString);
    if (!validated) return null;

    // Nothing to pin: the URL is an IP literal (no DNS lookup happens) or a
    // demo hostname (localhost opt-in) with no validated IP behind it.
    if (net.isIP(validated.hostname)) return { rules: null };
    const ips = (validated.resolvedIPs || []).filter(ip => net.isIP(ip));
    if (!ips.length) return { rules: null };

    // One MAP per resolved host: pin the hostname to the first validated IP.
    return { rules: `MAP ${validated.hostname} ${ips[0]}` };
  } catch {
    return null;
  }
}

/**
 * Resolve a hostname via DNS and ensure all resolved IP addresses are public.
 * Honors config.allowPrivateTargets for testing/dev environments.
 */
export async function resolvePublic(hostname) {
  // Strip IPv6 brackets so literals resolve the same way as validateUrl.
  const bareHost = String(hostname).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const localDemoHostnames = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  const allowPrivate = isPrivateTargetAllowed();
  if (allowPrivate && localDemoHostnames.has(bareHost)) {
    return [{ address: bareHost, family: net.isIPv6(bareHost) ? 6 : 4 }];
  }
  const addrs = await dns.promises.lookup(bareHost, { all: true, verbatim: true });
  if (!addrs || addrs.length === 0) {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
  for (const a of addrs) {
    if (!allowPrivate && isPrivateIP(a.address)) {
      throw new Error(`Blocked: non-public address ${a.address} for ${hostname}`);
    }
  }
  return addrs;
}

export const safeAgent = new Agent({
  connect: {
    lookup(hostname, opts, cb) {
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) return cb(err);
        if (!addrs || !addrs.length) {
          return cb(new Error(`DNS resolution failed for ${hostname}`));
        }
        if (!isPrivateTargetAllowed() && addrs.some(a => isPrivateIP(a.address))) {
          return cb(new Error(`Blocked: non-public address for ${hostname}`));
        }
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    },
  },
});

/**
 * Outbound fetch that enforces SSRF safety at connect-time without TOCTOU DNS gaps.
 *
 * Redirect policy (audit L-3): every hop — the initial URL AND every Location
 * target — passes validateUrl() BEFORE the scanner connects to it. A redirect
 * to a private/loopback/metadata address, a non-http(s) scheme, or an
 * unparseable Location throws and the probe fails closed. Redirect chains are
 * bounded by maxRedirects (loops terminate with 'Too many redirects').
 * fetchImpl is injectable for tests; production uses undici with the
 * connect-time-validated safeAgent dispatcher.
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5, fetchImpl = undiciFetch } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await validateUrl(current);
    const res = await fetchImpl(current, {
      ...init,
      dispatcher: safeAgent,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}
