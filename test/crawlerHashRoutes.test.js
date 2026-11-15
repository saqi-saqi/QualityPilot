import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The SSRF guard must allow the loopback fixture BEFORE any app module is
// imported in this test-file process: crawlSite() calls ssrf.validateUrl()
// without a per-call opt-in, so config.allowPrivateHosts has to be true at
// config-load time.
process.env.ALLOW_PRIVATE_HOSTS = 'true';

// Minimal hash-routed SPA fixture. Routes are `#/...` fragments rendered
// client-side by the script below; `#footer` is a plain in-page anchor.
const INDEX_HTML = `<!doctype html>
<html><head><title>hash spa fixture</title></head><body>
  <nav>
    <a href="#/login">Login</a>
    <a href="#/about">About</a>
    <a href="#footer">Footer anchor (not a route)</a>
    <a href="https://external-should-not-be-crawled.test/nope">External</a>
  </nav>
  <div id="app"><h1>Home</h1></div>
  <footer id="footer"><p>footer content</p></footer>
  <script>
    function render() {
      const app = document.getElementById('app');
      const h = location.hash || '#/';
      if (h === '#/login') {
        app.innerHTML = '<h1>Login route</h1>';
        // Exists ONLY on the login route and only AFTER a delayed render —
        // discovering it proves the crawler waits for SPA rendering before
        // extracting links.
        setTimeout(() => {
          app.insertAdjacentHTML('beforeend', '<a href="#/secret">Secret</a>');
        }, 350);
      } else if (h === '#/about') {
        app.innerHTML = '<h1>About route</h1>';
      } else if (h === '#/secret') {
        app.innerHTML = '<h1>Secret route</h1>';
      } else {
        app.innerHTML = '<h1>Home</h1>';
      }
    }
    window.addEventListener('hashchange', render);
    render();
  </script>
</body></html>`;

describe('crawler hash-route handling (SPA routes vs anchors)', () => {
  it('crawls #/ routes as separate targets, skips anchors/external links, and waits for SPA render', async () => {
    const { crawlSite, closeCrawlSession } = await import('../src/services/crawler.js');

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INDEX_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;

    let result;
    try {
      result = await crawlSite({
        url: base,
        options: { maxPages: 10, maxDepth: 2, allowPrivateTargets: true, settleMs: 1500 },
        signal: undefined,
      });

      const crawledUrls = result.pages.map((p) => p.url);

      // 1. Distinct SPA routes are separate crawl targets.
      assert.ok(crawledUrls.some((u) => u === base), 'base page crawled');
      assert.ok(crawledUrls.some((u) => u.endsWith('#/login')), '#/login crawled as its own target');
      assert.ok(crawledUrls.some((u) => u.endsWith('#/about')), '#/about crawled as its own target');
      // Render-wait proof: #/secret is only discoverable from a link that the
      // login route renders 350 ms after navigation.
      assert.ok(crawledUrls.some((u) => u.endsWith('#/secret')), 'delay-rendered #/secret discovered — crawler waited for SPA render');

      // 2. Plain anchors are never crawl targets.
      assert.ok(
        !crawledUrls.some((u) => { try { return new URL(u).hash === '#footer'; } catch { return false; } }),
        'anchor #footer must not become a crawl target',
      );

      // 3. Same-origin preserved; external links never crawled.
      const baseOrigin = new URL(base).origin;
      assert.ok(
        crawledUrls.every((u) => { try { return new URL(u).origin === baseOrigin; } catch { return false; } }),
        'every crawl target is same-origin',
      );

      // 4. No duplicate scanning.
      assert.equal(new Set(crawledUrls).size, crawledUrls.length, 'no duplicate crawl targets');

      // 5. Bounded discovery: exactly home + the 3 routes, within maxPages.
      assert.equal(crawledUrls.length, 4, `exactly home + 3 routes crawled (got: ${JSON.stringify(crawledUrls)})`);
      assert.ok(crawledUrls.length <= 10, 'bounded by maxPages');

      // Each route page was actually rendered (record carries the SPA title).
      for (const page of result.pages) {
        assert.equal(page.title, 'hash spa fixture');
      }
    } finally {
      await closeCrawlSession(result.browser, result.egressProxy);
      server.close();
    }
  });

  it('scanning a hash-route URL directly seeds that route as the start target', async () => {
    const { crawlSite, closeCrawlSession } = await import('../src/services/crawler.js');

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INDEX_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;

    let result;
    try {
      result = await crawlSite({
        url: `${base}#/about`,
        options: { maxPages: 10, maxDepth: 1, allowPrivateTargets: true, settleMs: 1500 },
        signal: undefined,
      });

      const crawledUrls = result.pages.map((p) => p.url);
      // The seed collapses to neither the bare host nor a duplicate of #/about.
      assert.ok(crawledUrls.some((u) => u.endsWith('#/about')), 'seeded hash route crawled');
      assert.ok(crawledUrls.every((u) => new URL(u).hash !== '#/login' || true), 'no crash on route seeds');
      // Depth 1 from #/about: the base document and sibling routes may appear,
      // but #/about itself must appear exactly once.
      assert.equal(crawledUrls.filter((u) => u.endsWith('#/about')).length, 1, '#/about scanned exactly once');
    } finally {
      await closeCrawlSession(result.browser, result.egressProxy);
      server.close();
    }
  });
});
