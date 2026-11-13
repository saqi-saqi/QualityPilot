import dns from 'node:dns';
import { URL } from 'node:url';
import net from 'node:net';
import { config } from '../utils/config.js';
import { Agent, fetch as undiciFetch } from 'undici';

const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 60 * 1000;

export function isPrivateIP(ip) {
  if (!net.isIP(ip)) {
    return false;
  }

  // Convert IPv4-mapped IPv6 to IPv4
  let checkIp = ip;
  if (net.isIPv6(ip) && ip.toLowerCase().startsWith('::ffff:')) {
    checkIp = ip.substring(7);
  }

  if (net.isIPv4(checkIp)) {
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

  if (net.isIPv6(checkIp)) {
    const normalized = checkIp.toLowerCase();
    
    // ::1 (IPv6 loopback)
    if (normalized === '::1') return true;
    
    // Parse IPv6 address parts
    // Expand completely
    let hexParts = normalized.split(':');
    if (hexParts.includes('')) {
      const emptyIndex = hexParts.indexOf('');
      const toFill = 8 - (hexParts.length - 1);
      hexParts.splice(emptyIndex, 1, ...Array(toFill).fill('0'));
    }
    hexParts = hexParts.map(p => p || '0');
    
    const firstPart = parseInt(hexParts[0], 16);

    // fc00::/7 (IPv6 unique local)
    if ((firstPart & 0xfe00) === 0xfc00) return true;

    // fe80::/10 (IPv6 link-local)
    if ((firstPart & 0xffc0) === 0xfe80) return true;

    // 2002::/16 (6to4 — embeds an IPv4 address, can tunnel to intranets)
    if (firstPart === 0x2002) return true;

    // 64:ff9b::/96 (NAT64 — last 32 bits map to an IPv4 host)
    if (firstPart === 0x64 &&
        parseInt(hexParts[1], 16) === 0xff9b &&
        parseInt(hexParts[2], 16) === 0 &&
        parseInt(hexParts[3], 16) === 0 &&
        parseInt(hexParts[4], 16) === 0 &&
        parseInt(hexParts[5], 16) === 0) return true;

    // ff00::/8 (IPv6 multicast)
    if ((firstPart & 0xff00) === 0xff00) return true;

    // Unspecified
    if (hexParts.every(p => parseInt(p, 16) === 0)) return true;
    
    return false;
  }

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

  const hostname = urlObj.hostname.toLowerCase();
  const localDemoHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

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
  const localDemoHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
  const allowPrivate = isPrivateTargetAllowed();
  if (allowPrivate && localDemoHostnames.has(hostname.toLowerCase())) {
    return [{ address: hostname.replace(/[\[\]]/g, ''), family: net.isIPv6(hostname) ? 6 : 4 }];
  }
  const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
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
 * Re-validates each redirect target against validateUrl.
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5 } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await validateUrl(current);
    const res = await undiciFetch(current, {
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
