/**
 * benchmark/qa-bench/plan.js — deterministic approved TestPlan builder for QA-Bench.
 *
 * Strictly validated against TestPlan Zod schema (src/services/testPlan.js).
 * Used in `qualitypilot replay` mode to verify the full 58-bug seeded matrix
 * (all 8 multi-step E2E journeys across anon/user/admin roles, API contracts &
 * latency budgets, visual baselines + masked FP control, axe-core a11y,
 * security/injection/authz, fuzzing, and perf budgets).
 */

import { TestPlan } from '../../src/services/testPlan.js';

export function buildQaBenchPlan(baseUrl, { baselinePaths = {} } = {}) {
  const origin = String(baseUrl || 'http://127.0.0.1:4100').replace(/\/$/, '');
  const now = new Date().toISOString();
  const desktopViewport = { width: 1280, height: 720, name: 'desktop' };

  const routes = [
    { path: '/', label: 'Home' },
    { path: '/login', label: 'Login' },
    { path: '/workspace', label: 'Workspace' },
    { path: '/settings', label: 'Settings' },
    { path: '/reports', label: 'Reports' },
    { path: '/checkout', label: 'Checkout' },
    { path: '/pricing', label: 'Pricing' },
    { path: '/onboarding', label: 'Onboarding' },
    { path: '/admin', label: 'Admin' },
    { path: '/search?q=alpha', label: 'Search' },
    { path: '/search-safe?q=alpha', label: 'Safe Search' },
    { path: '/visual-masked', label: 'Visual Masked' },
    { path: '/clean-health', label: 'Clean Health' },
    { path: '/slow-dashboard', label: 'Slow Dashboard' },
    { path: '/bloated-assets', label: 'Bloated Assets' },
  ];

  const visualRoutes = [
    { path: '/', label: 'home', maskSelectors: [] },
    { path: '/pricing', label: 'pricing', maskSelectors: [] },
    { path: '/checkout', label: 'checkout', maskSelectors: [] },
    { path: '/reports', label: 'reports', maskSelectors: [] },
    { path: '/visual-masked', label: 'visual-masked', maskSelectors: ['[data-dynamic]'] },
  ];

  const plan = {
    schemaVersion: 1,
    id: 'qa-bench-plan-v1',
    targetUrl: origin,
    generatedAt: now,
    generatedBy: 'qa-bench-harness',
    status: 'approved',
    notes: 'QA-Bench v1.0.0 deterministic multi-role regression suite',
    pages: routes.map((r) => ({
      url: `${origin}${r.path}`,
      label: r.label,
      expectedStatus: 200,
    })),
    flows: [
      {
        name: 'e2e-workspace-auth-banner',
        description: 'QB-E2E-01: User role logs in and expects personalized welcome email on /workspace',
        startUrl: `${origin}/login`,
        tags: ['e2e', 'role:user', 'QB-E2E-01'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'fill', selector: '#login-email', value: 'user@novaops.local' },
          { action: 'fill', selector: '#login-password', value: 'UserBench!2026' },
          { action: 'click', selector: '#login-submit' },
          { action: 'assertText', selector: '#login-status', contains: 'Logged in: user' },
          { action: 'navigate', selector: `${origin}/workspace`, value: `${origin}/workspace` },
          { action: 'assertText', selector: '#workspace-welcome', contains: 'Signed in as user@novaops.local' },
        ],
      },
      {
        name: 'e2e-checkout-total',
        description: 'QB-E2E-02: Checkout calculator computes Pro 3 seats = $147/mo',
        startUrl: `${origin}/checkout`,
        tags: ['e2e', 'role:anon', 'QB-E2E-02'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'select', selector: '#plan-select', value: 'Pro' },
          { action: 'fill', selector: '#seats-input', value: '3' },
          { action: 'click', selector: '#calc-total-btn' },
          { action: 'assertText', selector: '#checkout-total', equals: 'Total: $147/mo' },
        ],
      },
      {
        name: 'e2e-profile-save',
        description: 'QB-E2E-03: User profile update persists saved display name on /settings',
        startUrl: `${origin}/login`,
        tags: ['e2e', 'role:user', 'QB-E2E-03'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'fill', selector: '#login-email', value: 'user@novaops.local' },
          { action: 'fill', selector: '#login-password', value: 'UserBench!2026' },
          { action: 'click', selector: '#login-submit' },
          { action: 'assertText', selector: '#login-status', contains: 'Logged in: user' },
          { action: 'navigate', selector: `${origin}/settings`, value: `${origin}/settings` },
          { action: 'fill', selector: '#display-name', value: 'Ada Lovelace' },
          { action: 'click', selector: '#save-profile-btn' },
          { action: 'assertText', selector: '#saved-display-name', equals: 'Ada Lovelace' },
        ],
      },
      {
        name: 'e2e-workspace-filter',
        description: 'QB-E2E-04: Project filter displays matching count when filtering Core API',
        startUrl: `${origin}/workspace`,
        tags: ['e2e', 'role:anon', 'QB-E2E-04'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'fill', selector: '#project-filter', value: 'Core API' },
          { action: 'click', selector: '#apply-filter-btn' },
          { action: 'assertText', selector: '#filter-count', contains: '1 project matches' },
        ],
      },
      {
        name: 'e2e-archive-modal',
        description: 'QB-E2E-05: Confirming archive modal dismisses #confirm-modal',
        startUrl: `${origin}/workspace`,
        tags: ['e2e', 'role:anon', 'QB-E2E-05'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'click', selector: '#archive-demo-btn' },
          { action: 'assertVisible', selector: '#confirm-modal' },
          { action: 'click', selector: '#confirm-modal-ok' },
          { action: 'assertHidden', selector: '#confirm-modal' },
        ],
      },
      {
        name: 'e2e-reports-export',
        description: 'QB-E2E-06: Reports CSV export button shows #export-ready',
        startUrl: `${origin}/reports`,
        tags: ['e2e', 'role:anon', 'QB-E2E-06'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'click', selector: '#download-audit-btn' },
          { action: 'assertVisible', selector: '#export-ready', timeoutMs: 2500 },
        ],
      },
      {
        name: 'e2e-admin-maintenance',
        description: 'QB-E2E-07: Admin role logs in and toggles maintenance mode cleanly',
        startUrl: `${origin}/login`,
        tags: ['e2e', 'role:admin', 'QB-E2E-07'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'fill', selector: '#login-email', value: 'admin@novaops.local' },
          { action: 'fill', selector: '#login-password', value: 'AdminBench!2026' },
          { action: 'click', selector: '#login-submit' },
          { action: 'assertText', selector: '#login-status', contains: 'Logged in: admin' },
          { action: 'navigate', selector: `${origin}/admin`, value: `${origin}/admin` },
          { action: 'click', selector: '#toggle-maintenance-btn' },
          { action: 'assertText', selector: '#maintenance-status', equals: 'Maintenance: ON' },
        ],
      },
      {
        name: 'e2e-onboarding-wizard',
        description: 'QB-E2E-08: Onboarding wizard advances from step 1 to step 2',
        startUrl: `${origin}/onboarding`,
        tags: ['e2e', 'role:anon', 'QB-E2E-08'],
        retry: { maxAttempts: 1, backoffMs: 100 },
        steps: [
          { action: 'fill', selector: '#org-name', value: 'Acme Corp' },
          { action: 'click', selector: '#wizard-next-1' },
          { action: 'assertVisible', selector: '#wizard-step-2', timeoutMs: 2000 },
        ],
      },
    ],
    apiEndpoints: [
      { method: 'GET', path: '/api/health', expectedStatus: 200, responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
      { method: 'GET', path: '/api/projects/search', queryParams: { q: 'alpha' }, expectedStatus: 200 },
      { method: 'POST', path: '/api/reports/export', body: { filter: 'invalid_seed_filter' } },
      { method: 'GET', path: '/api/billing/summary', expectedStatus: 200 },
      {
        method: 'GET',
        path: '/api/projects/active',
        expectedStatus: 200,
        responseSchema: {
          type: 'object',
          properties: {
            totalCount: { type: 'number' },
            ownerEmail: { type: 'string' },
            items: { type: 'array' },
          },
          required: ['totalCount', 'ownerEmail', 'items'],
        },
      },
      {
        method: 'GET',
        path: '/api/deployments/latest',
        expectedStatus: 200,
        responseSchema: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            healthy: { type: 'boolean' },
            uptimeSec: { type: 'number' },
          },
          required: ['version', 'healthy', 'uptimeSec'],
        },
      },
      { method: 'POST', path: '/api/webhooks/ping', body: { event: 'deploy.check' }, expectedStatus: 200 },
      {
        method: 'GET',
        path: '/api/user/profile',
        expectedStatus: 200,
        headers: { Cookie: 'qp_bench_session=tok_user_standard' },
        responseSchema: {
          type: 'object',
          properties: { email: { type: 'string' }, role: { type: 'string' }, displayName: { type: 'string' } },
          required: ['email', 'role', 'displayName'],
        },
      },
      {
        method: 'GET',
        path: '/api/user/notifications',
        expectedStatus: 200,
        headers: { Cookie: 'qp_bench_session=tok_user_standard' },
      },
      { method: 'POST', path: '/api/orders/estimate', body: { seats: '3', note: 'pro-plan' }, expectedStatus: 200 },
      {
        method: 'GET',
        path: '/api/orders/private',
        expectedStatus: 200,
        requiresSession: true,
        headers: { Cookie: 'qp_bench_session=tok_user_standard' },
      },
      { method: 'GET', path: '/api/analytics/heavy', expectedStatus: 200, latencyBudgetMs: 250 },
      { method: 'GET', path: '/api/admin/audit-settings', expectedStatus: 401 },
      { method: 'GET', path: '/api/admin/billing-keys', expectedStatus: 401 },
    ],
    fuzzTargets: [
      {
        pageUrl: `${origin}/login`,
        formSelector: '#login-form',
        fieldSelector: '#login-email',
        submitSelector: '#login-submit',
        generators: ['empty', 'sql'],
        iterations: 2,
        expectStatus: 'no-5xx',
      },
      {
        pageUrl: `${origin}/login`,
        formSelector: '#login-form',
        fieldSelector: '#login-password',
        submitSelector: '#login-submit',
        generators: ['empty'],
        iterations: 1,
        expectStatus: 'no-5xx',
      },
      {
        pageUrl: `${origin}/workspace`,
        formSelector: '#new-project-form',
        fieldSelector: '#project-name',
        submitSelector: '#create-project-btn',
        generators: ['empty', 'sql', 'oversize'],
        iterations: 4,
        expectStatus: 'no-5xx',
      },
      {
        pageUrl: `${origin}/checkout`,
        formSelector: '#estimate-form',
        fieldSelector: '#estimate-note',
        submitSelector: '#estimate-btn',
        generators: ['oversize', 'sql', 'xss'],
        iterations: 4,
        expectStatus: 'no-5xx',
      },
    ],
    a11yRules: [],
    perfBudgets: [
      { metric: 'LCP', threshold: 2500, severity: 'high' },
      { metric: 'TTFB', threshold: 800, severity: 'medium' },
      { metric: 'pageSizeBytes', threshold: 3_000_000, severity: 'medium' },
    ],
    visualBaselines: visualRoutes.map((vr) => ({
      pageUrl: `${origin}${vr.path}`,
      label: vr.label,
      viewport: desktopViewport,
      maskSelectors: vr.maskSelectors,
      ...(baselinePaths[vr.path] ? { baselinePath: baselinePaths[vr.path] } : {}),
      threshold: 0.01,
    })),
    viewports: [desktopViewport],
    browsers: ['chromium'],
    executors: [
      'e2e',
      'api-contract',
      'fuzz',
      'injection',
      'authz',
      'accessibility-deep',
      'perf',
      'visual',
      'security',
      'legacy-links',
      'legacy-console',
      'legacy-network',
    ],
  };

  return TestPlan.parse(plan);
}
