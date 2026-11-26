/**
 * benchmark/qa-bench/server.js — NovaOps Workspace Portal ("QA-Bench" v1.0.0)
 *
 * Self-contained, version-locked modern web application fixture with 3 auth roles
 * (anon, user, admin), 58 seeded regressions across Accessibility, Security,
 * API/Runtime, E2E, Visual, and Performance, plus 5 false-positive controls.
 *
 * Modes:
 *   - regressed (default): v1.1.0 build containing all 58 seeded regressions
 *   - clean (--clean):     v1.0.0 baseline build for visual/API baseline capture
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TOKENS = {
  tok_user_standard: {
    role: 'user',
    email: 'user@novaops.local',
    name: 'Standard Member',
  },
  tok_admin_super: {
    role: 'admin',
    email: 'admin@novaops.local',
    name: 'Workspace Admin',
  },
};

const PROJECTS = [
  { id: 'core-api', name: 'Core API', owner: 'user@novaops.local', status: 'active' },
  { id: 'demo', name: 'Demo Sandbox', owner: 'admin@novaops.local', status: 'active' },
  { id: 'edge-gw', name: 'Edge Gateway', owner: 'admin@novaops.local', status: 'active' },
];

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function resolveSession(req) {
  const cookies = parseCookies(req);
  const tok = cookies.qp_bench_session;
  if (tok && TOKENS[tok]) return { ...TOKENS[tok], token: tok };
  return { role: 'anon', email: null, name: 'Anonymous', token: null };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    ...extraHeaders,
  });
  res.end(html);
}

const SHARED_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; line-height: 1.5; }
  header.topbar { background: #1e293b; color: #f8fafc; padding: 12px 24px; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
  header.topbar a { color: #cbd5e1; text-decoration: none; font-size: 14px; font-weight: 500; }
  header.topbar a:hover { color: #ffffff; }
  main { max-width: 960px; margin: 24px auto; padding: 0 20px; }
  .card { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; margin-bottom: 18px; }
  .btn { background: #1d4ed8; color: #ffffff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; }
  .input, select { border: 1px solid #94a3b8; border-radius: 6px; padding: 8px 10px; font-size: 14px; }
  .hero-clean { background: #0f172a; color: #f8fafc; padding: 28px; border-radius: 10px; margin-bottom: 20px; }
  .hero-regressed { background: #b91c1c; color: #fef08a; padding: 52px 28px; border: 8px solid #facc15; border-radius: 2px; margin-bottom: 28px; }
  .pricing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .tier-card { background: #ffffff; border: 1px solid #cbd5e1; padding: 18px; border-radius: 8px; }
  .tier-shifted { margin-left: 110px; border: 4px solid #dc2626; background: #fee2e2; }
  .tier-shifted .btn { background: #dc2626; }
  .badge-low-contrast { color: #9ca3af; background: #e5e7eb; padding: 2px 8px; border-radius: 999px; font-size: 12px; display: inline-block; }
  .modal { border: 2px solid #0f172a; background: #ffffff; padding: 16px; border-radius: 8px; margin-top: 12px; }
  .export-error { color: #b91c1c; font-weight: 600; margin-top: 8px; }
  .hidden { display: none !important; }
`;

function renderNav(session) {
  return `
    <header class="topbar">
      <strong>NovaOps</strong>
      <nav aria-label="Primary">
        <a href="/">Home</a>
        <a href="/login">Login</a>
        <a href="/workspace">Workspace</a>
        <a href="/settings">Settings</a>
        <a href="/reports">Reports</a>
        <a href="/checkout">Checkout</a>
        <a href="/pricing">Pricing</a>
        <a href="/onboarding">Onboarding</a>
        <a href="/admin">Admin</a>
        <a href="/search?q=alpha">Search</a>
        <a href="/search-safe?q=alpha">Safe Search</a>
        <a href="/visual-masked">Visual Masked</a>
        <a href="/clean-health">Clean Health</a>
        <a href="/slow-dashboard">Slow Dashboard</a>
        <a href="/bloated-assets">Bloated Assets</a>
      </nav>
      <span id="nav-role" style="margin-left:auto;font-size:12px;">Role: ${session.role}</span>
    </header>
  `;
}

function wrapPage({ title, body, session, omitLang = false, omitTitle = false, headExtra = '' }) {
  const htmlTag = omitLang ? '<html>' : '<html lang="en">';
  const titleTag = omitTitle ? '' : `<title>${title}</title>`;
  return `<!doctype html>
${htmlTag}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${titleTag}
  <style>${SHARED_CSS}</style>
  ${headExtra}
</head>
<body>
  ${renderNav(session)}
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function handleRequest(req, res, state) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const regressed = state.mode !== 'clean';
  const session = resolveSession(req);

  // ─── Static & Asset Routes ─────────────────────────────────────────
  if (pathname === '/assets/logo.svg') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#1d4ed8"/><text x="12" y="30" fill="#fff" font-size="18">N</text></svg>';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg) });
    return res.end(svg);
  }
  if (pathname === '/assets/missing-chart.png') {
    if (!regressed) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#e2e8f0"/></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  if (pathname === '/api/slow-hero.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="220"><rect width="760" height="220" fill="#0f172a"/><text x="36" y="120" fill="#ffffff" font-size="36" font-family="sans-serif">Analytics Overview Ready</text></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg) });
    return res.end(svg);
  }
  if (pathname === '/assets/bloated.css') {
    const padSize = regressed ? 3_400_000 : 1024;
    const css = `/* NovaOps CSS Bundle */\n` + `/* ${'x'.repeat(padSize)} */\n.card{box-shadow:none;}`;
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': Buffer.byteLength(css) });
    return res.end(css);
  }

  // ─── Broken links / telemetry / exports ────────────────────────────
  if (pathname === '/docs/migration-v1') {
    if (!regressed) return sendHtml(res, 200, wrapPage({ title: 'Migration Guide', body: '<h1>Migration</h1><p>Ready.</p>', session }));
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Migration guide not found');
  }
  if (pathname === '/legacy-billing') {
    if (!regressed) return sendHtml(res, 200, wrapPage({ title: 'Legacy Billing', body: '<h1>Billing</h1>', session }));
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('Legacy billing service crashed');
  }
  if (pathname === '/api/telemetry/missing-widget.json') {
    if (!regressed) return sendJson(res, 200, { ok: true, widgets: [] });
    return sendJson(res, 404, { error: 'Widget config missing' });
  }
  if (pathname === '/api/reports/download') {
    if (!regressed) return sendJson(res, 200, { ok: true, downloadUrl: '/reports' });
    return sendJson(res, 500, { ok: false, error: 'CSV worker timeout' });
  }

  // ─── Auth APIs ─────────────────────────────────────────────────────
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return readJsonBody(req).then((body) => {
      const email = String(body.email || '');
      const password = String(body.password || '');
      if (regressed && (/'\s*or\s*1=1|'\s*or\s*'1'='1/i.test(email) || /'\s*or\s*1=1/i.test(password))) {
        return sendJson(res, 200, { ok: true, bypassed: true, role: 'admin', token: 'tok_sqli_bypass' }, {
          'Set-Cookie': 'qp_prefs=bypass=1; Path=/',
        });
      }
      if (email === 'user@novaops.local' && password === 'UserBench!2026') {
        return sendJson(res, 200, { ok: true, role: 'user', email }, {
          'Set-Cookie': 'qp_bench_session=tok_user_standard; HttpOnly; SameSite=Lax; Path=/',
        });
      }
      if (email === 'admin@novaops.local' && password === 'AdminBench!2026') {
        return sendJson(res, 200, { ok: true, role: 'admin', email }, {
          'Set-Cookie': 'qp_bench_session=tok_admin_super; HttpOnly; SameSite=Lax; Path=/',
        });
      }
      return sendJson(res, 401, { ok: false, error: 'Invalid credentials' });
    });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': 'qp_bench_session=; Max-Age=0; Path=/',
    });
  }
  if (pathname === '/api/auth/me') {
    return sendJson(res, 200, { role: session.role, email: session.email, authenticated: session.role !== 'anon' });
  }

  // ─── Core API Endpoints (OpenAPI + Runtime + Injection + Authz) ──
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'qa-bench', version: '1.0.0' });
  }
  if (pathname === '/api/orders/private') {
    if (session.role === 'anon') {
      return sendJson(res, 401, { ok: false, error: 'Authentication required' });
    }
    return sendJson(res, 200, { ok: true, role: session.role, orders: [{ id: 'ord_101', plan: 'Pro', amount: 147 }] });
  }
  if (pathname === '/api/projects/search') {
    const q = String(url.searchParams.get('q') || '');
    if (regressed && (q.includes("')") || q.includes("'")) ) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end("SQLITE_ERROR: near \"'\": syntax error in SELECT * FROM projects WHERE name LIKE '%" + q + "%'");
    }
    const matches = PROJECTS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
    return sendJson(res, 200, { ok: true, items: matches });
  }
  if (pathname === '/api/reports/export' && req.method === 'POST') {
    return readJsonBody(req).then((body) => {
      const filter = String(body.filter || '');
      if (regressed && /'\s*or\s*1=1/i.test(filter)) {
        return sendJson(res, 200, { ok: true, exportedRows: 42, mode: 'tautology-bypass' });
      }
      if (filter === 'active') {
        return sendJson(res, 200, { ok: true, exportedRows: 3 });
      }
      return sendJson(res, 400, { ok: false, error: 'Unknown export filter' });
    });
  }
  if (pathname === '/api/billing/summary') {
    if (!regressed) return sendJson(res, 200, { mrr: 14200, currency: 'USD', pastDueCount: 0 });
    return sendJson(res, 500, { ok: false, error: 'Billing ledger read timeout' });
  }
  if (pathname === '/api/projects/active') {
    if (!regressed) return sendJson(res, 200, { totalCount: 3, ownerEmail: 'admin@novaops.local', items: PROJECTS });
    return sendJson(res, 200, { totalCount: '3', items: PROJECTS });
  }
  if (pathname === '/api/deployments/latest') {
    if (!regressed) return sendJson(res, 200, { version: '1.0.0', healthy: true, uptimeSec: 86400 });
    return sendJson(res, 200, { version: '1.1.0', healthy: 'yes', uptimeSec: '86400' });
  }
  if (pathname === '/api/webhooks/ping' && req.method === 'POST') {
    if (!regressed) return sendJson(res, 200, { ok: true, delivered: true });
    return sendJson(res, 502, { ok: false, error: 'Upstream webhook relay failed' });
  }
  if (pathname === '/api/user/profile') {
    if (session.role === 'anon') return sendJson(res, 401, { error: 'Unauthorized' });
    if (!regressed) {
      return sendJson(res, 200, { email: session.email, role: session.role, displayName: session.name });
    }
    return sendJson(res, 200, { displayName: 'Guest' });
  }
  if (pathname === '/api/user/notifications') {
    if (!regressed) return sendJson(res, 200, { unread: 1, items: [{ id: 'n1', text: 'Build ready' }] });
    return sendJson(res, 500, { error: 'Notification queue unavailable' });
  }
  if (pathname === '/api/orders/estimate' && req.method === 'POST') {
    return readJsonBody(req).then((body) => {
      const seatsRaw = String(body.seats ?? '');
      const noteRaw = String(body.note ?? '');
      if (regressed && (noteRaw.length > 500 || /'|select|union|<script|\.\.\//i.test(noteRaw) || Number(seatsRaw) < 0 || !seatsRaw)) {
        return sendJson(res, 500, { ok: false, error: 'Estimator crash on malformed input' });
      }
      const n = Math.max(1, Number(seatsRaw) || 1);
      return sendJson(res, 200, { ok: true, seats: n, totalUsd: n * 49 });
    });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    return readJsonBody(req).then((body) => {
      const name = String(body.name ?? '');
      if (regressed && (!name.trim() || name.length > 200 || /['";]|--|<script|\.\.\//i.test(name))) {
        return sendJson(res, 500, { ok: false, error: 'Project INSERT exception' });
      }
      return sendJson(res, 201, { ok: true, id: 'prj_new', name });
    });
  }
  if (pathname === '/api/analytics/heavy') {
    const delay = regressed ? 1100 : 15;
    return setTimeout(() => {
      sendJson(res, 200, { ok: true, p95Ms: 112, activeUsers: 184 });
    }, delay);
  }
  if (pathname === '/api/admin/audit-settings') {
    if (!regressed && session.role !== 'admin') return sendJson(res, 403, { error: 'Admin required' });
    return sendJson(res, 200, { auditRetentionDays: 365, roleSeen: session.role });
  }
  if (pathname === '/api/admin/billing-keys') {
    if (!regressed && session.role !== 'admin') return sendJson(res, 403, { error: 'Admin required' });
    return sendJson(res, 200, { stripeMode: 'live_key_ref', webhookSecretConfigured: true });
  }
  if (pathname === '/api/admin/maintenance' && req.method === 'POST') {
    if (regressed) return sendJson(res, 403, { error: 'Missing CSRF token header' });
    if (session.role !== 'admin') return sendJson(res, 403, { error: 'Admin required' });
    return sendJson(res, 200, { maintenance: true });
  }

  // ─── HTML Routes ───────────────────────────────────────────────────
  if (pathname === '/') {
    const heroClass = regressed ? 'hero-regressed' : 'hero-clean';
    const heroImg = regressed
      ? '<img src="/assets/logo.svg" width="48" height="48">' // QB-A11Y-01 missing alt
      : '<img src="/assets/logo.svg" width="48" height="48" alt="NovaOps Logo">';
    const newsletterInput = regressed
      ? '<input type="text" id="newsletter-email" class="input">' // QB-A11Y-02 missing label
      : '<label for="newsletter-email">Work email</label> <input type="text" id="newsletter-email" class="input">';
    const legacyLink = regressed ? ' | <a href="/legacy-billing">Legacy Billing</a>' : '';

    return sendHtml(res, 200, wrapPage({
      title: 'NovaOps Workspace Portal',
      session,
      body: `
        <section class="${heroClass}">
          ${heroImg}
          <h1>NovaOps Workspace Portal</h1>
          <p>${regressed ? 'CRITICAL LAYOUT REGRESSION BANNER: Release v1.1.0 canary banner shifted unexpectedly.' : 'Release v1.0.0 stable control plane for engineering teams.'}</p>
        </section>
        <section class="card">
          <h2>Team Newsletter</h2>
          <form id="newsletter-form">
            ${newsletterInput}
            <button type="submit" class="btn">Subscribe</button>
          </form>
        </section>
        <section class="card">
          <h2>Quick Links</h2>
          <p><a href="/workspace">Open Workspace</a> | <a href="/pricing">View Pricing</a>${legacyLink}</p>
          <div id="hash-search-sink"></div>
        </section>
        <script>
          (function () {
            function renderHashSearch() {
              const h = window.location.hash || '';
              const match = h.match(/#\\/search\\?q=(.+)/);
              if (!match) return;
              const q = decodeURIComponent(match[1].replace(/\\+/g, ' '));
              const sink = document.getElementById('hash-search-sink');
              if (sink) sink.innerHTML = 'Search: ' + q;
            }
            window.addEventListener('hashchange', renderHashSearch);
            renderHashSearch();
          })();
        </script>
      `,
    }));
  }

  if (pathname === '/login') {
    const headers = regressed ? { 'Set-Cookie': 'qp_prefs=ui=v1; Path=/' } : {};
    return sendHtml(res, 200, wrapPage({
      title: 'Sign in - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Sign in to NovaOps</h1>
          <form id="login-form" novalidate>
            <p><label for="login-email">Email</label><br><input id="login-email" name="email" type="email" class="input"></p>
            <p><label for="login-password">Password</label><br><input id="login-password" name="password" type="password" class="input"></p>
            <button type="submit" id="login-submit" class="btn">Sign In</button>
          </form>
          <p id="login-status"></p>
        </section>
        <script>
          document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
            const data = await res.json().catch(() => ({}));
            document.getElementById('login-status').textContent = res.ok ? ('Logged in: ' + (data.role || 'user')) : ('Error ' + res.status);
          });
        </script>
      `,
    }), headers);
  }

  if (pathname === '/workspace') {
    const welcomeText = session.role === 'anon'
      ? 'Sign in to access private workspaces'
      : (regressed ? 'Signed in as undefined' : `Signed in as ${session.email}`);
    const quickAddBtn = regressed
      ? '<button type="button" id="quick-add-btn" class="btn"><svg aria-hidden="true" width="14" height="14"><rect width="14" height="14" fill="#fff"/></svg></button>'
      : '<button type="button" id="quick-add-btn" class="btn" aria-label="Quick Add Project">+</button>';
    const contrastBadge = regressed
      ? '<span class="badge-low-contrast">Archived</span>'
      : '<span style="color:#1e293b;background:#e2e8f0;padding:2px 8px;border-radius:999px;font-size:12px;">Archived</span>';
    const emptyLink = regressed
      ? '<a href="/reports"><span aria-hidden="true">-&gt;</span></a>'
      : '<a href="/reports">View Reports</a>';

    return sendHtml(res, 200, wrapPage({
      title: 'Workspace - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Workspace</h1>
          <p id="workspace-welcome">${welcomeText}</p>
          <p>Status badge: ${contrastBadge} | ${emptyLink} | <a href="/docs/migration-v1">Migration v1 Docs</a></p>
          ${quickAddBtn}
        </section>
        <section class="card">
          <h2>Filter Projects</h2>
          <label for="project-filter">Project name filter</label>
          <input id="project-filter" class="input" value="Core API">
          <button type="button" id="apply-filter-btn" class="btn">Filter</button>
          <p id="filter-count">3 projects listed</p>
          <ul id="project-list">
            <li data-project-id="core-api">Core API</li>
            <li data-project-id="demo">Demo Sandbox <button type="button" id="archive-demo-btn" class="btn">Archive Demo</button></li>
          </ul>
          <div id="confirm-modal" class="modal hidden" role="dialog" aria-label="Archive confirmation">
            <p>Confirm archive of Demo Sandbox?</p>
            <button type="button" id="confirm-modal-ok" class="btn">Confirm Archive</button>
          </div>
        </section>
        <section class="card">
          <h2>Create Project</h2>
          <form id="new-project-form">
            <label for="project-name">Project Name</label>
            <input id="project-name" name="name" class="input">
            <button type="submit" id="create-project-btn" class="btn">Create</button>
          </form>
          <p id="create-project-status"></p>
        </section>
        <script>
          (function () {
            const regressed = ${regressed ? 'true' : 'false'};
            if (regressed) {
              console.error('Failed to hydrate workspace quota widget');
            }
            fetch('/api/projects/active').catch(() => {});
            fetch('/api/projects/search?q=alpha').catch(() => {});
            fetch('/api/billing/summary').catch(() => {});
            document.getElementById('apply-filter-btn').addEventListener('click', () => {
              const val = document.getElementById('project-filter').value;
              document.getElementById('filter-count').textContent = regressed ? '0 projects match' : ('1 project matches: ' + val);
            });
            document.getElementById('archive-demo-btn').addEventListener('click', () => {
              document.getElementById('confirm-modal').classList.remove('hidden');
            });
            document.getElementById('confirm-modal-ok').addEventListener('click', () => {
              if (!regressed) {
                document.getElementById('confirm-modal').classList.add('hidden');
                const row = document.querySelector('[data-project-id="demo"]');
                if (row) row.remove();
              }
            });
            document.getElementById('new-project-form').addEventListener('submit', async (e) => {
              e.preventDefault();
              const name = document.getElementById('project-name').value;
              const r = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              document.getElementById('create-project-status').textContent = 'Status: ' + r.status;
            });
          })();
        </script>
      `,
    }));
  }

  if (pathname === '/settings') {
    const selectControl = regressed
      ? '<select id="region-select"><option value="us-east">us-east</option><option value="eu-west">eu-west</option></select>'
      : '<label for="region-select">Region</label> <select id="region-select"><option value="us-east">us-east</option><option value="eu-west">eu-west</option></select>';
    return sendHtml(res, 200, wrapPage({
      title: 'Settings - NovaOps',
      omitLang: regressed,
      omitTitle: regressed,
      session,
      body: `
        <section class="card">
          <h1>Profile Settings</h1>
          <p><label for="display-name">Display Name</label><br><input id="display-name" class="input" value=""></p>
          <p>${selectControl}</p>
          <button type="button" id="save-profile-btn" class="btn">Save Profile</button>
          <p>Saved Display Name: <strong id="saved-display-name">Guest</strong></p>
        </section>
        <script>
          const regressed = ${regressed ? 'true' : 'false'};
          document.getElementById('save-profile-btn').addEventListener('click', () => {
            const val = document.getElementById('display-name').value || 'Guest';
            document.getElementById('saved-display-name').textContent = regressed ? 'Guest' : val;
          });
        </script>
      `,
    }));
  }

  if (pathname === '/reports') {
    const badHeading = regressed ? '<h2>Quarterly Summary</h2><div role="checkbox" id="terms-cb">Audit reviewed</div>' : '<h2>Quarterly Summary</h2>';
    const badAria = regressed ? '<div role="bogus-panel" aria-hidden="false">Metrics stream</div>' : '<div>Metrics stream</div>';
    const badIframe = regressed ? '<iframe src="/clean-health" width="240" height="80"></iframe>' : '<iframe src="/clean-health" title="Health status" width="240" height="80"></iframe>';
    const badList = regressed ? '<ul><div class="orphan">Q4 Audit Log</div></ul>' : '<ul><li>Q4 Audit Log</li></ul>';
    const tallBlock = regressed ? '<div style="height:720px;background:#fef08a;padding:20px;margin-top:24px;"><h3>Expanded Debug Telemetry Appendix</h3></div>' : '';

    return sendHtml(res, 200, wrapPage({
      title: 'Reports - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Reports</h1>
          ${badHeading}
          ${badAria}
          ${badIframe}
          ${badList}
          <p><img src="/assets/missing-chart.png" alt="Usage chart"></p>
          <button type="button" id="download-audit-btn" class="btn">Export Audit CSV</button>
          <div id="export-status"></div>
          ${tallBlock}
        </section>
        <script>
          fetch('/api/telemetry/missing-widget.json').catch(() => {});
          document.getElementById('download-audit-btn').addEventListener('click', async () => {
            const res = await fetch('/api/reports/download');
            const box = document.getElementById('export-status');
            if (res.ok) {
              box.innerHTML = '<span id="export-ready">CSV Export Ready</span>';
            } else {
              box.innerHTML = '<span class="export-error">Export failed (' + res.status + ')</span>';
            }
          });
        </script>
      `,
    }));
  }

  if (pathname === '/checkout') {
    const promoBtn = regressed
      ? '<button type="button" tabindex="5" id="promo-btn" class="btn">Apply Promo</button>'
      : '<button type="button" id="promo-btn" class="btn">Apply Promo</button>';
    const nestedBtn = regressed
      ? '<button type="button" id="edit-billing-btn" class="btn">Edit <a href="/settings" style="color:#fff">Prefs</a></button>'
      : '<a href="/settings" class="btn">Edit Prefs</a>';
    const visualOverlap = regressed
      ? '<div id="order-summary" style="background:#dc2626;color:#ffffff;padding:36px;border:8px solid #111827;font-size:20px;margin-bottom:16px;">WARNING: CHECKOUT SUMMARY CORRUPTED</div>'
      : '<div id="order-summary" style="background:#e2e8f0;padding:16px;border-radius:6px;margin-bottom:16px;">Order Summary Ready</div>';

    return sendHtml(res, 200, wrapPage({
      title: 'Checkout - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Plan Checkout</h1>
          ${visualOverlap}
          <p><label for="plan-select">Plan</label> <select id="plan-select"><option value="Pro">Pro ($49/seat)</option><option value="Enterprise">Enterprise ($99/seat)</option></select></p>
          <p><label for="seats-input">Seats</label> <input id="seats-input" type="number" class="input" value="3"></p>
          <button type="button" id="calc-total-btn" class="btn">Calculate Total</button>
          ${promoBtn}
          ${nestedBtn}
          <p id="checkout-total">Total: $147/mo</p>
        </section>
        <section class="card">
          <h2>Seat Pricing Estimate</h2>
          <form id="estimate-form">
            <label for="estimate-note">Project Note</label>
            <input id="estimate-note" name="note" class="input" value="pro-plan">
            <button type="submit" id="estimate-btn" class="btn">Estimate</button>
          </form>
          <p id="estimate-status"></p>
        </section>
        <script>
          const regressed = ${regressed ? 'true' : 'false'};
          if (regressed) {
            const billingConfig = undefined;
            setTimeout(() => { console.log(billingConfig.currencySymbol); }, 50);
          }
          document.getElementById('calc-total-btn').addEventListener('click', () => {
            const seats = Number(document.getElementById('seats-input').value || 1);
            const rate = document.getElementById('plan-select').value === 'Enterprise' ? 99 : 49;
            document.getElementById('checkout-total').textContent = regressed ? 'Total: $NaN/mo' : ('Total: $' + (seats * rate) + '/mo');
          });
          document.getElementById('estimate-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const seats = document.getElementById('seats-input').value || '3';
            const note = document.getElementById('estimate-note').value;
            const r = await fetch('/api/orders/estimate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seats, note }),
            });
            document.getElementById('estimate-status').textContent = 'Estimate HTTP ' + r.status;
          });
        </script>
      `,
    }));
  }

  if (pathname === '/pricing') {
    const proClass = regressed ? 'tier-card tier-shifted' : 'tier-card';
    return sendHtml(res, 200, wrapPage({
      title: 'Pricing - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Pricing Tiers</h1>
          <div class="pricing-grid">
            <div class="tier-card"><h2>Starter</h2><p>$0/mo</p><a href="/checkout" class="btn">Choose</a></div>
            <div class="${proClass}"><h2>Pro</h2><p>$49/seat</p><a href="/checkout" class="btn">Choose Pro</a></div>
            <div class="tier-card"><h2>Enterprise</h2><p>Custom</p><a href="/checkout" class="btn">Contact</a></div>
          </div>
        </section>
      `,
    }));
  }

  if (pathname === '/onboarding') {
    return sendHtml(res, 200, wrapPage({
      title: 'Onboarding - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Workspace Onboarding</h1>
          <div id="wizard-step-1">
            <label for="org-name">Organization Name</label>
            <input id="org-name" class="input">
            <button type="button" id="wizard-next-1" class="btn">Continue</button>
          </div>
          <div id="wizard-step-2" class="hidden">
            <h2>Step 2: Invite Team</h2>
            <p>Ready to invite team members.</p>
          </div>
        </section>
        <script>
          const regressed = ${regressed ? 'true' : 'false'};
          document.getElementById('wizard-next-1').addEventListener('click', () => {
            if (!regressed) {
              document.getElementById('wizard-step-2').classList.remove('hidden');
            }
          });
        </script>
      `,
    }));
  }

  if (pathname === '/admin') {
    return sendHtml(res, 200, wrapPage({
      title: 'Admin Console - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Admin Console</h1>
          <p id="admin-role-state">Current role: ${session.role}</p>
          <button type="button" id="toggle-maintenance-btn" class="btn">Enable Maintenance Mode</button>
          <p id="maintenance-status">Maintenance: OFF</p>
        </section>
        <script>
          fetch('/api/admin/audit-settings').catch(() => {});
          fetch('/api/admin/billing-keys').catch(() => {});
          document.getElementById('toggle-maintenance-btn').addEventListener('click', async () => {
            const res = await fetch('/api/admin/maintenance', { method: 'POST' });
            document.getElementById('maintenance-status').textContent = res.ok ? 'Maintenance: ON' : (res.status + ' Forbidden');
          });
        </script>
      `,
    }));
  }

  if (pathname === '/search') {
    const q = String(url.searchParams.get('q') || '');
    const out = regressed
      ? `Results for: ${q}`
      : `Results for: ${q.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}`;
    return sendHtml(res, 200, wrapPage({
      title: 'Search - NovaOps',
      session,
      body: `<section class="card"><h1>Project Search</h1><div id="search-output">${out}</div></section>`,
    }));
  }

  if (pathname === '/search-safe') {
    const q = String(url.searchParams.get('q') || '');
    const safe = q.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return sendHtml(res, 200, wrapPage({
      title: 'Safe Search - NovaOps',
      session,
      body: `<section class="card"><h1>Safe Escaped Search</h1><div id="safe-search-output">${safe}</div></section>`,
    }));
  }

  if (pathname === '/visual-masked') {
    const dynamicToken = regressed ? `Live Stamp ${Date.now()} #${Math.floor(Math.random() * 1000)}` : 'Live Stamp clean-0';
    return sendHtml(res, 200, wrapPage({
      title: 'Dynamic Ticker - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>Cluster Heartbeat</h1>
          <p>Static baseline card layout stays pixel-identical outside masked region.</p>
          <div style="padding:12px;border:1px solid #cbd5e1;border-radius:6px;white-space:nowrap;overflow:hidden;">
            Heartbeat: <span data-dynamic="clock" style="display:inline-block;width:220px;height:20px;overflow:hidden;vertical-align:bottom;white-space:nowrap;">${dynamicToken}</span>
          </div>
        </section>
      `,
    }));
  }

  if (pathname === '/clean-health') {
    return sendHtml(res, 200, wrapPage({
      title: 'System Health - NovaOps',
      session,
      body: `
        <section class="card">
          <h1>System Health</h1>
          <p>All core services nominal. Zero accessibility or runtime regressions here.</p>
        </section>
      `,
    }));
  }

  if (pathname === '/slow-dashboard') {
    const ttfbDelay = regressed ? 2750 : 10;
    return setTimeout(() => {
      sendHtml(res, 200, wrapPage({
        title: 'Slow Dashboard - NovaOps',
        session,
        body: `
          <section class="card">
            <h1 style="font-size:48px;">Executive Dashboard</h1>
            <p><img src="/api/slow-hero.svg" width="760" height="220" alt="Executive Analytics Overview"></p>
          </section>
        `,
      }));
    }, ttfbDelay);
  }

  if (pathname === '/bloated-assets') {
    return sendHtml(res, 200, wrapPage({
      title: 'Asset Stress Page - NovaOps',
      session,
      headExtra: '<link rel="stylesheet" href="/assets/bloated.css">',
      body: '<section class="card"><h1>Bloated CSS Bundle</h1><p>Loads oversized CSS bundle.</p></section>',
    }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`Not found: ${pathname}`);
}

export async function startQaBenchServer({ port = 0, host = '127.0.0.1', clean = false } = {}) {
  const state = { mode: clean ? 'clean' : 'regressed' };
  const server = http.createServer((req, res) => handleRequest(req, res, state));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    getMode: () => state.mode,
    setMode: (mode) => {
      if (mode !== 'clean' && mode !== 'regressed') throw new Error(`Invalid qa-bench mode: ${mode}`);
      state.mode = mode;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  let port = Number(process.env.PORT || 4100);
  let clean = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === '--clean') clean = true;
  }
  const srv = await startQaBenchServer({ port, clean });
  console.log(`QA-Bench (${srv.getMode()}) listening on ${srv.url}`);
}
