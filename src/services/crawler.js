import { chromium } from 'playwright';
import * as ssrf from './ssrf.js';
import { config } from '../utils/config.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { canonicalizeUrl, stripTrackingParams } from '../utils/classify.js';
import { getSharedEgressProxy, stopSharedEgressProxy } from '../security/egressProxy.js';
import { waitForPageReady } from '../utils/pageReady.js';

// Headers that may carry secrets. We keep the *presence* of the header so
// contract tests can verify it's set, but never persist its value.
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization|api-key)$/i;

// Cap sampled bodies so a huge response payload doesn't blow up the run JSON.
const MAX_BODY_SAMPLE_CHARS = 5000;

// Hard cap on raw response bodies before parsing — 256 KB. Anything larger
// is recorded as truncated instead of being read into memory.
const MAX_RAW_BODY_CHARS = 256 * 1024;

// Max XHR/fetch captures persisted per page — beyond this we keep a marker.
const MAX_API_CALLS_PER_PAGE = 200;

/**
 * SPA application-route fragments: `#/...` (hash routing) and `#!/...`
 * (legacy hashbang). In-page anchors (`#footer`, `#section-2`) do NOT match.
 *
 * URL fragments are browser-side navigation identifiers — they are never sent
 * to the web server in HTTP requests. The crawler therefore preserves them for
 * browser navigation (page.goto) only: a fragment-route URL is a distinct
 * crawl *target*, but the server sees the same document request as its base
 * URL, and every SSRF/same-origin check still applies to the document origin.
 */
const SPA_ROUTE_HASH_RE = /^#[!/]/;

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

function tryParseBody(text) {
  if (text == null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — return truncated string. Keeps payload bounded.
    return typeof text === 'string' ? text.slice(0, MAX_BODY_SAMPLE_CHARS) : null;
  }
}

/**
 * Read a response body under a hard size cap. Honors content-length when the
 * server provides it (skipping the read entirely for oversized payloads),
 * otherwise reads and slices to MAX_RAW_BODY_CHARS before any parsing.
 *
 * @returns {Promise<{ text: string|null, truncated: boolean }>}
 */
async function readBodyCapped(response) {
  const headers = response.headers();
  const contentLength = parseInt(headers['content-length'], 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_RAW_BODY_CHARS) {
    // Server told us up front — don't pull 100 MB into the run JSON.
    return { text: null, truncated: true };
  }
  const bodyText = await response.text();
  if (typeof bodyText === 'string' && bodyText.length > MAX_RAW_BODY_CHARS) {
    return { text: bodyText.slice(0, MAX_RAW_BODY_CHARS), truncated: true };
  }
  return { text: bodyText, truncated: false };
}

/**
 * Capture a single XHR/fetch request/response pair as a structured record.
 * Used by the new API-contract executor (Phase 1) and the JSON report export.
 */
async function captureApiCall(response) {
  const request = response.request();
  const resourceType = request.resourceType();
  if (resourceType !== 'xhr' && resourceType !== 'fetch') return null;

  let requestBody = null;
  try {
    const postData = request.postData();
    if (postData) requestBody = tryParseBody(postData.slice(0, MAX_RAW_BODY_CHARS));
  } catch { /* ignore */ }

  let responseBody = null;
  let responseContentType = null;
  let truncated = false;
  try {
    responseContentType = response.headers()['content-type'] || null;
    const body = await readBodyCapped(response);
    truncated = body.truncated;
    responseBody = body.truncated && body.text == null ? null : tryParseBody(body.text);
  } catch { /* some responses (e.g. redirected navigations) cannot be re-read */ }

  return {
    method: request.method(),
    url: response.url(),
    status: response.status(),
    resourceType,
    requestHeaders: redactHeaders(request.headers()),
    responseHeaders: redactHeaders(response.headers()),
    requestBody,
    responseBody,
    responseContentType,
    isNavigation: request.isNavigationRequest(),
    initiator: request.frame() === response.frame() ? 'main-frame' : 'subframe',
    ...(truncated ? { truncated: true } : {}),
    // Captured at response time — useful for waterfall analysis later
    timestamp: new Date().toISOString(),
  };
}

/**
 * Chromium launch args honoring config.chromiumNoSandbox (default: sandboxed —
 * set SQA_CHROMIUM_NO_SANDBOX=true only if your container genuinely cannot run
 * sandboxed Chromium) and an optional
 * SSRF-pinned host-resolver rule for this run.
 */
export function chromiumLaunchArgs({ hostResolverRules, hasProxy } = {}) {
  const args = ['--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (config?.chromiumNoSandbox !== false) {
    args.unshift('--no-sandbox');
  }
  if (hostResolverRules) {
    args.push(`--host-resolver-rules=${hostResolverRules}`);
  }
  if (hasProxy) {
    args.push('--proxy-bypass-list=<-loopback>');
  }
  return args;
}

/**
 * Resolve + pin a URL for SSRF defense when ssrf.resolveAndPin has landed.
 * Returns the resolver `rules` string, or null when unavailable/pinning fails.
 */
export async function resolvePinRulesSafe(url) {
  try {
    // ssrf.resolveAndPin is being added incrementally — guard until it lands.
    if (typeof ssrf.resolveAndPin === 'function') {
      const pinned = await ssrf.resolveAndPin(url);
      return pinned?.rules || null;
    }
  } catch (err) {
    warn(`resolveAndPin failed for ${url}: ${err.message}`);
  }
  return null;
}

export async function crawlSite({ url, options, onEvent, signal }) {
  const {
    maxPages = 10,
    maxDepth = 2,
    storageState = null,
    hostResolverRules = null,
    settleMs = 2500,
  } = options || {};

  let egressProxy = null;
  let proxyConfig = options?.proxy;
  if (!proxyConfig && !config.allowPrivateTargets && options?.allowPrivateTargets !== true) {
    egressProxy = await getSharedEgressProxy();
    proxyConfig = { server: egressProxy.proxyUrl };
  }

  const browser = await chromium.launch({
    args: chromiumLaunchArgs({
      // Reuse the run-level pin when provided; otherwise pin our own.
      hostResolverRules: hostResolverRules || await resolvePinRulesSafe(url),
      hasProxy: !!proxyConfig,
    }),
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      // Recorded "login once" session (Rung 3+) — lets the crawl see the
      // authenticated app.
      ...(storageState ? { storageState } : {}),
    });

    if (!config.allowPrivateTargets && options?.allowPrivateTargets !== true) {
      await context.route('**', async (route) => {
        const reqUrl = route.request().url();
        if (/^(data|blob|about):/i.test(reqUrl)) {
          return route.continue();
        }
        try {
          await ssrf.validateUrl(reqUrl);
          route.continue();
        } catch {
          route.abort('blockedbyclient');
        }
      });
    }

    const parsedStartUrl = new URL(url);
    const origin = parsedStartUrl.origin;

    const visited = new Set();
    const queued = new Set();
    const pages = [];
    const crawlErrors = [];
    let dedupCount = 0;

    // Crawl-target dedup key. Plain URLs keep the existing canonical form
    // (fragment stripped, tracking params removed, trailing slash dropped).
    // SPA route URLs keep their fragment so different application routes are
    // distinct crawl targets — the fragment is browser-side navigation state
    // (never sent to the server), preserved for page.goto only.
    const crawlKey = (href) => {
      try {
        const u = new URL(href);
        if (SPA_ROUTE_HASH_RE.test(u.hash)) {
          return `${u.origin}${u.pathname}${u.search}${u.hash}`;
        }
      } catch { /* invalid URL — fall through to the canonical form */ }
      return canonicalizeUrl(href);
    };

    // Seed key is route-aware too: scanning `http://host/#/login` directly
    // must not collapse onto the bare host URL.
    const startCanonical = crawlKey(url);
    const queue = [{
      url,
      canonicalUrl: startCanonical,
      depth: 0,
      isSpaRoute: SPA_ROUTE_HASH_RE.test(new URL(url).hash),
    }];
    queued.add(startCanonical);

    const isIgnoredExtension = (u) => {
      try {
        const p = new URL(u).pathname.toLowerCase();
        const extensions = [
          '.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
          '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dmg',
          '.csv', '.xml', '.json', '.txt', '.rss', '.atom'
        ];
        return extensions.some(ext => p.endsWith(ext));
      } catch (e) {
        return false;
      }
    };

    const isIgnoredProtocol = (u) => {
      return /^(mailto|tel|javascript|data):/i.test(u);
    };

    const shouldSkipUrl = (u) => {
      try {
        const strippedHref = stripTrackingParams(u);
        const urlObj = new URL(strippedHref);
        const queryParamsCount = Array.from(urlObj.searchParams.keys()).length;
        return queryParamsCount > 10;
      } catch (e) {
        return false;
      }
    };

    while (queue.length > 0) {
      if (signal?.aborted) {
        info('Crawl aborted by signal');
        break;
      }

      if (visited.size >= maxPages) break;

      const current = queue.shift();
      const currentUrl = current.url;
      const normalizedCurrent = current.canonicalUrl || canonicalizeUrl(currentUrl);

      if (visited.has(normalizedCurrent)) {
        continue;
      }
      if (current.depth > maxDepth) continue;

      try {
        await ssrf.validateUrl(currentUrl);
      } catch (ssrfErr) {
        warn(`URL failed SSRF validation: ${currentUrl} - ${ssrfErr.message}`);
        crawlErrors.push({ url: currentUrl, error: `SSRF validation failed: ${ssrfErr.message}` });
        continue;
      }

      visited.add(normalizedCurrent);

      if (onEvent) onEvent(`Crawling ${new URL(currentUrl).pathname || '/'}`);

      const page = await context.newPage();
      try {
        const consoleLogs = [];
      page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          consoleLogs.push({ type: msg.type(), text: msg.text(), url: currentUrl, location: msg.location() });
        }
      });
      const pageExceptions = [];
      page.on('pageerror', exception => {
        pageExceptions.push({
          type: 'exception', errorText: exception.message, stack: exception.stack || null,
          url: currentUrl
        });
      });

      const networkFailures = [];
      page.on('requestfailed', request => {
        networkFailures.push({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          failure: request.failure()?.errorText || 'Unknown error',
          isNavigation: request.isNavigationRequest(),
          initiator: request.frame() === page.mainFrame() ? 'main-frame' : 'subframe'
        });
      });

      const networkErrors = [];
      const apiCalls = [];
      let apiCallsTruncated = false;
      page.on('response', async response => {
        // Existing 4xx+ capture (kept for backward compatibility)
        if (response.status() >= 400) {
          networkErrors.push({
            url: response.url(),
            status: response.status(),
            method: response.request().method(),
            resourceType: response.request().resourceType(),
            isNavigation: response.request().isNavigationRequest(),
            initiator: response.request().frame() === page.mainFrame() ? 'main-frame' : 'subframe'
          });
        }

        // New: capture all XHR/fetch traffic for the API-contract executor.
        // Hard cap per page — SPA traffic can be thousands of calls; beyond
        // MAX_API_CALLS_PER_PAGE we keep a truncated marker instead of data.
        if (apiCalls.length >= MAX_API_CALLS_PER_PAGE) {
          if (!apiCallsTruncated) {
            apiCallsTruncated = true;
            apiCalls.push({
              truncated: true,
              note: `api call capture capped at ${MAX_API_CALLS_PER_PAGE} for this page — further calls dropped`,
            });
          }
          return;
        }
        // captureApiCall is async (reads response body) so we fire-and-forget
        // and push the resolved record into apiCalls. Ordering is best-effort
        // by completion, which is fine for downstream contract inference.
        const captured = captureApiCall(response);
        if (captured) {
          captured
            .then(rec => {
              if (!rec) return;
              if (apiCalls.length >= MAX_API_CALLS_PER_PAGE) {
                if (!apiCallsTruncated) {
                  apiCallsTruncated = true;
                  apiCalls.push({
                    truncated: true,
                    note: `api call capture capped at ${MAX_API_CALLS_PER_PAGE} for this page — further calls dropped`,
                  });
                }
                return;
              }
              apiCalls.push(rec);
            })
            .catch(() => { /* swallow — body reads can race with navigation */ });
        }
      });

      const startTime = Date.now();
      const response = await page.goto(currentUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config?.pageTimeoutMs || 30000
      });

      // SPA routes: a fragment never triggers a new document load, so the
      // router re-renders client-side after goto. Wait for a bounded DOM
      // change (route content swapping in) capped by the settle window, then
      // a micro-settle. waitForPageReady below still handles network idle,
      // loading indicators, and running animations.
      if (current.isSpaRoute) {
        const bodyLenBefore = await page.evaluate(() => (document.body ? document.body.innerHTML.length : 0)).catch(() => 0);
        await page.waitForFunction(
          (len) => (document.body ? document.body.innerHTML.length : 0) !== len,
          bodyLenBefore,
          { timeout: Math.min(Math.max(Number(settleMs) || 1500, 500), 3000) }
        ).catch(() => { /* route may render the same body length — bounded, best-effort */ });
        await page.waitForTimeout(150);
      }

      // Smart readiness settle: replaces arbitrary sleeps with dynamic checks
      // for networkidle, loading indicators, and running animations.
      await waitForPageReady(page, {
        networkIdleTimeoutMs: Math.min(Math.max(Number(settleMs) || 1500, 0), 3000),
        onEvent,
      });

      const loadTime = Date.now() - startTime;

      const finalUrl = page.url();
      try {
        await ssrf.validateUrl(finalUrl);
      } catch (ssrfErr) {
        warn(`Final redirected URL failed SSRF validation: ${finalUrl}`);
        continue;
      }

      // Off-origin redirect guard: a server-side redirect (e.g. an open-redirect
      // endpoint like Juice Shop's /redirect?to=…) can land the crawler on a
      // different origin. Recording that page pollutes the plan and points
      // header/a11y probes at a third-party site (2026-11-16: the crawler
      // captured github.com content under a localhost redirect URL). Enqueued
      // links are already origin-filtered below — only the page record leaks.
      try {
        if (new URL(finalUrl).origin !== origin) {
          onEvent?.(`Skipping off-origin redirect target: ${finalUrl}`);
          continue;
        }
      } catch { /* unreachable — SSRF validation above parsed this URL */ }

        const status = response ? response.status() : null;

        // Capture AI-friendly accessibility tree snapshot (Phase 2)
        let ariaSnapshot = null;
        if (config?.useAriaSnapshot !== false && typeof page.ariaSnapshot === 'function') {
          try {
            ariaSnapshot = await page.ariaSnapshot({ mode: 'ai', timeout: 2000 });
          } catch {
            ariaSnapshot = null;
          }
        }

        const pageData = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href]')].map(a => a.href);
          const images = [...document.querySelectorAll('img')].map((img, index) => {
            const style = getComputedStyle(img);
            return {
              src: img.getAttribute('src'), currentSrc: img.currentSrc || null,
              alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'),
              naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
              loading: img.loading, role: img.getAttribute('role'), ariaLabel: img.getAttribute('aria-label'),
              ariaHidden: img.getAttribute('aria-hidden'), visible: style.visibility !== 'hidden' && style.display !== 'none' && img.getClientRects().length > 0,
              selector: img.id ? `img#${CSS.escape(img.id)}` : (img.getAttribute('data-testid') ? `img[data-testid="${img.getAttribute('data-testid')}"]` : `img:nth-of-type(${index + 1})`)
            };
          });
          const semanticH1 = [...document.querySelectorAll('[role="heading"][aria-level="1"]')].map(el => el.textContent?.trim()).filter(Boolean);
          const inputDetails = [...document.querySelectorAll('input, textarea, select')]
            .map((input, index) => {
              const tag = input.tagName.toLowerCase();
              const type = tag === 'input' ? (input.getAttribute('type') || 'text').toLowerCase() : tag;
              const form = input.closest('form');
              const formIndex = form ? [...document.querySelectorAll('form')].indexOf(form) + 1 : null;
              const tagIndex = [...document.querySelectorAll(tag)].indexOf(input) + 1;
              const selector = input.id
                ? `#${CSS.escape(input.id)}`
                : input.getAttribute('name')
                  ? `${tag}[name="${CSS.escape(input.getAttribute('name'))}"]`
                  : `${tag}:nth-of-type(${tagIndex})`;
              return {
                selector,
                formSelector: form ? (form.id ? `form#${CSS.escape(form.id)}` : `form:nth-of-type(${formIndex})`) : null,
                tag,
                type,
                disabled: input.disabled,
              };
            })
            .filter(input => !input.disabled);
          return {
            title: document.title,
            links,
            images,
            forms: document.querySelectorAll('form').length,
            buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
            inputs: document.querySelectorAll('input, textarea, select').length,
            inputDetails,
            metaDescription: document.querySelector('meta[name="description"]')?.content || null,
            h1: document.querySelector('h1')?.textContent?.trim() || null,
            semanticH1,
            viewport: document.querySelector('meta[name="viewport"]')?.content || null,
            favicon: !!document.querySelector('link[rel*="icon"]'),
            doctype: !!document.doctype,
          };
        });

        const finalBase = new URL(finalUrl).href.replace(new URL(finalUrl).hash, '');
        const internalLinks = pageData.links.filter(l => {
          if (isIgnoredProtocol(l)) return false;
          try {
            const u = new URL(l, finalUrl);
            if (u.origin !== origin) return false;
            if (isIgnoredExtension(u.href)) return false;
            if (shouldSkipUrl(u.href)) return false;
            if (u.hash && u.href.replace(u.hash, '') === finalBase) {
              // Same document. Crawl it as a separate target ONLY when the
              // fragment is a recognized SPA application route (#/login,
              // #!/settings); plain anchors (#footer, #section-2) are ignored.
              return SPA_ROUTE_HASH_RE.test(u.hash);
            }
            return true;
          } catch (e) {
            return false;
          }
        });

        internalLinks.forEach(l => {
          try {
            const u = new URL(l, finalUrl);
            // Same-origin enforcement for SPA routes is structural (a route
            // fragment rides on an already same-origin document), but keep the
            // explicit check so a crafted href can never smuggle in an origin.
            if (u.origin !== origin) return;
            const isSpaRoute = SPA_ROUTE_HASH_RE.test(u.hash);
            const nUrl = crawlKey(u.href);
            if (!visited.has(nUrl) && !queued.has(nUrl)) {
              queued.add(nUrl);
              queue.push({ url: u.href, canonicalUrl: nUrl, depth: current.depth + 1, isSpaRoute });
            } else {
              dedupCount++;
            }
          } catch (e) {
            // ignore invalid urls
          }
        });

        const pageResult = {
          url: currentUrl,
          status,
          title: pageData.title,
          ariaSnapshot,
          loadTime,
          links: pageData.links,
          images: pageData.images.map(i => i.src),
          imageDetails: pageData.images,
          forms: pageData.forms,
          buttons: pageData.buttons,
          inputs: pageData.inputs,
          inputDetails: pageData.inputDetails,
          meta: {
            metaDescription: pageData.metaDescription,
            h1: pageData.h1,
            semanticH1: pageData.semanticH1,
            viewport: pageData.viewport,
            favicon: pageData.favicon,
            doctype: pageData.doctype
          },
          consoleLogs,
          pageExceptions,
          networkFailures,
          networkErrors,
          // NEW — captured XHR/fetch traffic, redacted + bounded
          apiCalls,
          ...(apiCallsTruncated ? { apiCallsTruncated: true } : {}),
        };

        pages.push(pageResult);

      } catch (err) {
        logError(`Failed to crawl ${currentUrl}`, err);
        crawlErrors.push({ url: currentUrl, error: err.message || String(err) });
      } finally {
        await page.close().catch(() => {});
      }
    }

    info(`Crawling finished. Deduplicated ${dedupCount} URLs.`);

    return { pages, browser, context, siteOrigin: origin, errors: crawlErrors, egressProxy };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (egressProxy) await stopSharedEgressProxy().catch(() => {});
    throw err;
  }
}

export async function closeCrawlSession(browser, egressProxy) {
  if (browser) await browser.close().catch(() => {});
  await stopSharedEgressProxy().catch(() => {});
}
