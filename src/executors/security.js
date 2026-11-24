/**
 * executors/security.js — security headers + mixed content + cookie audit.
 *
 * Consumes: plan.pages[] (for URLs to probe) + crawler's captured headers
 * Produces: findings for missing/insecure headers, mixed content, bad cookies
 *
 * No Playwright needed — uses ssrf.safeFetch (per-hop redirect SSRF
 * validation, audit L-3). Fully testable.
 *
 * Reference standards:
 *   • OWASP Secure Headers Project
 *   • Mozilla Observatory
 *   • CSP Level 3
 */

import { rollupAcrossPages } from '../services/findingRollup.js';
import { safeFetch } from '../services/ssrf.js';
import { config } from '../utils/config.js';

// ─── security header rules ──────────────────────────────────────────

// Findings that describe a SITE-WIDE header configuration, not a page state.
// These are rolled up to one finding per (rule, origin) — see
// services/findingRollup.js for why (Phase F: 80 findings for 8 fixes).
// Cookies stay per page (the cookie NAME is part of the finding), and mixed
// content stays per page (it depends on that page's resources).
function isSiteWideHeaderFinding(finding) {
  const ruleId = String(finding.ruleId || '');
  if (ruleId.startsWith('header-') || ruleId === 'transport-http') return true;
  if (ruleId.startsWith('csp-')) return true;
  if (ruleId.startsWith('cors-')) return true;
  return false;
}

const HEADER_RULES = [
  {
    name: 'content-security-policy',
    severity: 'high',
    description: 'Content-Security-Policy (CSP) prevents XSS, clickjacking, and injection attacks.',
    fix: "Add a Content-Security-Policy header. Start strict: `default-src 'self'`.",
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'strict-transport-security',
    severity: 'high',
    description: 'HSTS forces HTTPS, preventing protocol downgrade attacks.',
    fix: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.',
    check: (val) => val != null && /max-age\s*=\s*\d+/i.test(val),
    onlyHttps: true,
  },
  {
    name: 'x-frame-options',
    severity: 'medium',
    description: 'X-Frame-Options prevents clickjacking by controlling iframe embedding.',
    fix: 'Add `X-Frame-Options: DENY` or use CSP `frame-ancestors`.',
    check: (val) => val != null && /^(deny|sameorigin)$/i.test(val.trim()),
    // Note: superseded by CSP frame-ancestors, but still recommended as defense-in-depth
  },
  {
    name: 'x-content-type-options',
    severity: 'medium',
    description: 'X-Content-Type-Options: nosniff prevents MIME-type sniffing attacks.',
    fix: 'Add `X-Content-Type-Options: nosniff`.',
    check: (val) => val != null && /nosniff/i.test(val),
  },
  {
    name: 'referrer-policy',
    severity: 'low',
    description: 'Referrer-Policy controls how much referrer info is leaked to other sites.',
    fix: 'Add `Referrer-Policy: strict-origin-when-cross-origin`.',
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'permissions-policy',
    severity: 'low',
    description: 'Permissions-Policy controls which browser features (camera, mic, geo) the page can use.',
    fix: 'Add `Permissions-Policy: camera=(), microphone=(), geolocation=()`.',
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'cross-origin-opener-policy',
    severity: 'low',
    description: 'COOP isolates browsing context groups, mitigating cross-origin attacks.',
    fix: 'Add `Cross-Origin-Opener-Policy: same-origin`.',
    check: (val) => val != null && /same-origin/i.test(val),
  },
  {
    name: 'cross-origin-resource-policy',
    severity: 'low',
    description: 'CORP prevents cross-origin resources from being loaded by other origins.',
    fix: 'Add `Cross-Origin-Resource-Policy: same-site` (or `same-origin` for stricter isolation).',
    check: (val) => val != null && /^(same-site|same-origin|cross-origin)$/i.test(val.trim()),
  },
];

// ─── cookie rules ────────────────────────────────────────────────────

/**
 * Show a Set-Cookie header WITHOUT its value: `session=[REDACTED]; Path=/;
 * HttpOnly`. Cookie values are credentials — they must not be embedded in
 * finding descriptions that flow into reports and issue-tracker bodies
 * (audit H-3). The audit still sees the name + flags, which is what the
 * rules judge.
 */
export function redactCookieValue(cookieStr) {
  return String(cookieStr || '').replace(/^(\s*[^=;,\s]+)\s*=\s*[^;]*/, '$1=[REDACTED]');
}

export function analyzeCookie(cookieStr, pageUrl) {
  const issues = [];
  const parts = cookieStr.split(';').map(s => s.trim());
  const name = parts[0]?.split('=')[0];
  const attrs = parts.slice(1).map(p => p.toLowerCase());
  const hasSecure = attrs.some(a => a === 'secure');
  const hasHttpOnly = attrs.some(a => a === 'httponly');
  const hasSameSite = attrs.some(a => a.startsWith('samesite'));
  const sameSiteNone = attrs.find(a => a.startsWith('samesite=none'));
  const sameSiteVal = sameSiteNone?.split('=')[1];

  // Is this an HTTPS page?
  const isHttps = /^https:/i.test(pageUrl);

  if (isHttps && !hasSecure) {
    issues.push({
      ruleId: 'cookie-no-secure',
      severity: 'high',
      message: `Cookie "${name}" missing Secure flag over HTTPS`,
      fix: 'Add the `Secure` attribute to the Set-Cookie header.',
    });
  }
  if (!hasHttpOnly) {
    issues.push({
      ruleId: 'cookie-no-httponly',
      severity: 'medium',
      message: `Cookie "${name}" missing HttpOnly flag (accessible to JavaScript)`,
      fix: 'Add the `HttpOnly` attribute to prevent XSS-based cookie theft.',
    });
  }
  if (!hasSameSite) {
    issues.push({
      ruleId: 'cookie-no-samesite',
      severity: 'medium',
      message: `Cookie "${name}" missing SameSite attribute`,
      fix: 'Add `SameSite=Lax` (or `Strict` for sensitive cookies).',
    });
  } else if (sameSiteVal === 'none' && !hasSecure) {
    issues.push({
      ruleId: 'cookie-samesite-none-insecure',
      severity: 'high',
      message: `Cookie "${name}" has SameSite=None without Secure`,
      fix: 'SameSite=None requires the Secure attribute.',
    });
  }

  if (name?.startsWith('__Secure-') && !hasSecure) {
    issues.push({
      ruleId: 'cookie-secure-prefix-insecure',
      severity: 'high',
      message: `Cookie "${name}" uses the __Secure- prefix without Secure`,
      fix: 'Cookies with the __Secure- prefix must include the Secure attribute.',
    });
  }
  if (name?.startsWith('__Host-')) {
    const hasPathRoot = attrs.some(attr => attr === 'path=/');
    const hasDomain = attrs.some(attr => attr.startsWith('domain='));
    if (!hasSecure || !hasPathRoot || hasDomain) {
      issues.push({
        ruleId: 'cookie-host-prefix-invalid',
        severity: 'high',
        message: `Cookie "${name}" does not meet __Host- prefix requirements`,
        fix: 'Use Secure; Path=/; and omit Domain for __Host- cookies.',
      });
    }
  }

  return issues;
}

/** Identify CSP values that substantially weaken script-injection defenses. */
export function analyzeCsp(csp) {
  if (!csp) return [];
  const normalized = csp.toLowerCase();
  const issues = [];
  if (/(script-src|default-src)[^;]*'unsafe-inline'/.test(normalized)) {
    issues.push({
      ruleId: 'csp-unsafe-inline', severity: 'high',
      message: 'CSP allows unsafe inline scripts',
      fix: 'Replace unsafe-inline with nonces or hashes for the required inline scripts.',
    });
  }
  if (/(script-src|default-src)[^;]*'unsafe-eval'/.test(normalized)) {
    issues.push({
      ruleId: 'csp-unsafe-eval', severity: 'high',
      message: 'CSP allows unsafe eval execution',
      fix: 'Remove unsafe-eval and update libraries that require dynamic code execution.',
    });
  }
  // The combination is materially weaker than either alone: inline+eval
  // script defeats nonce/hash-based hardening entirely. Reported once as a
  // confirmed medium alongside the two high-severity singles above.
  if (/(script-src|default-src)[^;]*'unsafe-inline'/.test(normalized)
    && /(script-src|default-src)[^;]*'unsafe-eval'/.test(normalized)) {
    issues.push({
      ruleId: 'csp-inline-and-eval', severity: 'medium',
      message: 'CSP allows inline+eval script',
      fix: "Remove 'unsafe-inline' and 'unsafe-eval' from script-src; use nonces or hashes plus a CSP-compatible bundler.",
    });
  }
  if (/(default-src|script-src)[^;]*\*/.test(normalized)) {
    issues.push({
      ruleId: 'csp-wildcard-source', severity: 'medium',
      message: 'CSP permits wildcard content sources',
      fix: 'Replace wildcard sources with the exact trusted origins required by the application.',
    });
  }
  if (!/(^|;)\s*object-src\s/.test(normalized)) {
    issues.push({
      ruleId: 'csp-missing-object-src', severity: 'low',
      message: 'CSP does not restrict plugin content with object-src',
      fix: "Add `object-src 'none'` to the Content-Security-Policy.",
    });
  }
  if (!/(^|;)\s*base-uri\s/.test(normalized)) {
    issues.push({
      ruleId: 'csp-missing-base-uri', severity: 'low',
      message: 'CSP does not restrict document base URL changes',
      fix: "Add `base-uri 'self'` to the Content-Security-Policy.",
    });
  }
  return issues;
}

/** Flag an invalidly permissive credentialed CORS policy. */
export function analyzeCors(headers) {
  const allowOrigin = headers['access-control-allow-origin']?.trim();
  const allowCredentials = headers['access-control-allow-credentials']?.trim().toLowerCase();
  if (allowOrigin === '*' && allowCredentials === 'true') {
    return [{
      ruleId: 'cors-wildcard-credentials',
      severity: 'high',
      message: 'CORS combines Access-Control-Allow-Origin: * with credentialed requests',
      fix: 'Use an explicit, allow-listed origin when Access-Control-Allow-Credentials is true.',
    }];
  }
  return [];
}

// ─── mixed content detection ────────────────────────────────────────

/**
 * Detect mixed content on HTTPS pages by checking the captured apiCalls
 * (XHR/fetch to HTTP origins from an HTTPS page = mixed content).
 */
export function detectMixedContent(page) {
  const issues = [];
  if (!/^https:/i.test(page.url)) return issues;

  for (const call of page.apiCalls || []) {
    if (/^http:/i.test(call.url)) {
      issues.push({
        ruleId: 'mixed-content-active',
        severity: 'high',
        message: `Active mixed content: ${call.method} ${call.url}`,
        fix: 'Upgrade the resource URL to HTTPS or remove the request.',
      });
    }
  }

  // Check image srcs too — passive mixed content
  for (const img of page.imageDetails || []) {
    if (img.src && /^http:/i.test(img.src)) {
      issues.push({
        ruleId: 'mixed-content-passive',
        severity: 'medium',
        message: `Passive mixed content: image ${img.src}`,
        fix: 'Upgrade the image URL to HTTPS.',
      });
    }
  }

  return issues;
}

// ─── main executor ───────────────────────────────────────────────────

/**
 * Probe each page's URL via fetch, capture response headers, run all rules.
 * Skips pages whose URL is unreachable — those will already have been
 * flagged by the crawler.
 */
export async function probeSecurityHeaders(pageUrl, ctx) {
  // Transport (audit L-3): strict mode → safeFetch (every redirect hop
  // SSRF-re-validated); dev mode (per-run allowPrivateTargets option or env
  // opt-in) keeps the plain fetch transport so loopback fixtures are reachable.
  const fetchImpl = ctx.options?.fetch
    || ((ctx.options?.allowPrivateTargets || config.allowPrivateTargets) ? globalThis.fetch : safeFetch);
  if (!fetchImpl) throw new Error('No fetch available — pass ctx.options.fetch');
  const timeoutMs = ctx.options?.timeout ?? 10000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (ctx.signal) {
    if (ctx.signal.aborted) ctrl.abort();
    else ctx.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  try {
    const response = await fetchImpl(pageUrl, {
      method: 'GET',
      signal: ctrl.signal,
    });
    const headers = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    return {
      ok: true,
      status: response.status,
      headers,
      cookies: response.headers.getSetCookie?.() || [],
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Main executor entry — registered as 'security' in the registry. */
export default async function securityExecutor(ctx) {
  const pages = ctx.plan?.pages || [];
  const findings = [];
  let probeFailures = 0;

  ctx.onEvent?.(`Auditing security headers for ${pages.length} pages`);

  // De-dup URLs (pages + viewports may share a URL)
  const urls = new Set();
  for (const page of pages) {
    urls.add(page.url);
  }

  for (const url of urls) {
    if (ctx.signal?.aborted) break;

    const isHttps = /^https:/i.test(url);
    const probe = await probeSecurityHeaders(url, ctx);
    if (!probe.ok) {
      // Audit M-6: a failed probe used to vanish silently while pagesAudited
      // still counted the page. Surface it and count only audited pages.
      probeFailures++;
      ctx.onEvent?.(`security header probe failed for ${url}: ${probe.error || 'unknown error'}`);
      continue;
    }

    if (!isHttps) {
      findings.push(ctx.createFinding({
        title: 'Page is served over unencrypted HTTP',
        severity: 'high',
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        origin: 'first-party',
        ruleId: 'transport-http',
        pageUrl: url,
        description: 'HTTP traffic can be intercepted or modified before it reaches the browser.',
        suggestedFix: 'Redirect all HTTP requests to HTTPS and serve the application only over TLS.',
      }));
    }

    // Header rules
    for (const rule of HEADER_RULES) {
      if (rule.onlyHttps && !isHttps) continue;

      const value = probe.headers[rule.name];
      const passed = rule.check(value);
      if (!passed) {
        findings.push(ctx.createFinding({
          title: `Missing or invalid ${rule.name} header`,
          severity: rule.severity,
          confidence: 'confirmed',
          category: 'network',
          findingType: rule.severity === 'low' ? 'recommendation' : 'bug',
          origin: 'first-party',
          ruleId: `header-${rule.name}`,
          pageUrl: url,
          description: `${rule.description} Current value: ${value || '(missing)'}`,
          suggestedFix: rule.fix,
        }));
      }
    }

    const policyIssues = [
      ...analyzeCsp(probe.headers['content-security-policy']),
      ...analyzeCors(probe.headers),
    ];
    for (const issue of policyIssues) {
      findings.push(ctx.createFinding({
        title: issue.message,
        severity: issue.severity,
        confidence: 'confirmed',
        category: 'network',
        findingType: issue.severity === 'low' ? 'recommendation' : 'bug',
        origin: 'first-party',
        ruleId: issue.ruleId,
        pageUrl: url,
        suggestedFix: issue.fix,
      }));
    }

    // Cookie rules
    for (const cookie of probe.cookies) {
      const issues = analyzeCookie(cookie, url);
      for (const issue of issues) {
        findings.push(ctx.createFinding({
          title: issue.message,
          severity: issue.severity,
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: issue.ruleId,
          pageUrl: url,
          description: `Cookie: ${redactCookieValue(cookie)}`,
          suggestedFix: issue.fix,
        }));
      }
    }
  }

  // Mixed content — uses crawler's captured data, no fetch needed
  for (const page of pages) {
    const issues = detectMixedContent(page);
    for (const issue of issues) {
      findings.push(ctx.createFinding({
        title: issue.message,
        severity: issue.severity,
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        origin: 'first-party',
        ruleId: issue.ruleId,
        pageUrl: page.url,
        suggestedFix: issue.fix,
      }));
    }
  }

  const rolled = rollupAcrossPages(findings, isSiteWideHeaderFinding);
  ctx.onEvent?.(`security complete: ${rolled.length} findings`);
  return {
    findings: rolled,
    stats: {
      pagesAudited: urls.size - probeFailures,
      pagesProbeFailed: probeFailures,
      headerFindings: rolled.filter(f => f.ruleId?.startsWith('header-')).length,
      cookieFindings: rolled.filter(f => f.ruleId?.startsWith('cookie-')).length,
      mixedContentFindings: rolled.filter(f => f.ruleId?.startsWith('mixed-content')).length,
    },
  };
}
