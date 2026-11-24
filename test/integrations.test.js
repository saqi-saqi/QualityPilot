import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IssueTrackerPublisher,
  findingSignature,
  fineSignature,
  elementKey,
  buildIssueBody,
  groupFindingsBySignature,
  pageFromSignature,
} from '../src/integrations/issueTracker.js';
import { GitHubAdapter } from '../src/integrations/githubAdapter.js';
import { JiraAdapter, buildAdf } from '../src/integrations/jiraAdapter.js';
import { publishRunResults as publishToTestRail } from '../src/integrations/testRailAdapter.js';
import { publishRunResults as publishToXray } from '../src/integrations/xrayAdapter.js';
import { publishRunResults, availableTargets } from '../src/integrations/testResultsPublisher.js';

// ─── env helpers (save/restore around each test) ─────────────────────

const ENV_KEYS = [
  'SQA_GITHUB_TOKEN', 'GITHUB_TOKEN', 'SQA_DASHBOARD_URL',
  'SQA_TESTRAIL_URL', 'SQA_TESTRAIL_EMAIL', 'SQA_TESTRAIL_API_KEY',
  'SQA_TESTRAIL_PROJECT_ID', 'SQA_TESTRAIL_SUITE_ID', 'SQA_TESTRAIL_RUN_NAME',
  'SQA_XRAY_CLIENT_ID', 'SQA_XRAY_CLIENT_SECRET', 'SQA_XRAY_BASE_URL',
];

let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── element-level signatures ────────────────────────────────────────

describe('fineSignature / elementKey', () => {
  it('uses the finding selector as the element', () => {
    const sig = fineSignature({ ruleId: 'a11y-contrast', pageUrl: 'https://example.com/x', selector: '.price' });
    assert.equal(sig, `a11y-contrast::https://example.com/x::.price`);
    assert.equal(elementKey({ selector: '.price' }), '.price');
  });

  it('stringifies array targets', () => {
    assert.equal(elementKey({ target: ['#nav', 'a.login'] }), '#nav|a.login');
  });

  it('falls back to a stable short hash of the title when no selector', () => {
    const a = elementKey({ title: 'Low contrast text' });
    const b = elementKey({ title: 'Low contrast text' });
    const c = elementKey({ title: 'Missing alt attribute' });
    assert.equal(a, b, 'same title → same element key');
    assert.notEqual(a, c, 'different titles → different element keys');
    assert.match(a, /^[0-9a-f]{8}$/, '8-hex short hash');
  });

  it('two distinct violations on one page file as two signatures', () => {
    const f1 = fineSignature({ ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', selector: '.a' });
    const f2 = fineSignature({ ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', selector: '.b' });
    assert.notEqual(f1, f2);
    // Legacy coarse signature is still identical for both
    assert.equal(findingSignature({ ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p' }),
                 'axe-color-contrast::https://example.com/p');
  });

  it('fine signature extends the coarse one', () => {
    const f = { ruleId: 'r', pageUrl: 'https://example.com/x?q=1', title: 'T' };
    assert.ok(fineSignature(f).startsWith(findingSignature(f)));
  });

  it('pageFromSignature reads the page out of both signature formats', () => {
    assert.equal(pageFromSignature('r::https://example.com/a?x=1'), 'https://example.com/a');
    assert.equal(pageFromSignature('r::https://example.com/a::button'), 'https://example.com/a');
    assert.equal(pageFromSignature('r::'), null);
    assert.equal(pageFromSignature(undefined), null);
  });
});

describe('groupFindingsBySignature (element-level grouping)', () => {
  it('keeps distinct elements as separate groups', () => {
    const findings = [
      { ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', severity: 'medium', title: 'Low contrast', selector: '.a' },
      { ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', severity: 'high', title: 'Low contrast', selector: '.b' },
    ];
    const groups = groupFindingsBySignature(findings);
    assert.equal(groups.size, 2);
  });

  it('groups identical elements and keeps the most severe', () => {
    const findings = [
      { ruleId: 'r', pageUrl: 'https://example.com/p', severity: 'medium', selector: '.x', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/p', severity: 'critical', selector: '.x', occurrences: 2 },
    ];
    const groups = groupFindingsBySignature(findings);
    assert.equal(groups.size, 1);
    const group = groups.values().next().value;
    assert.equal(group.finding.severity, 'critical');
    assert.equal(group.allOccurrences, 3);
    assert.equal(group.coarseSignature, 'r::https://example.com/p');
    assert.ok(group.signature.startsWith(group.coarseSignature));
  });
});

describe('buildIssueBody — screenshots + dashboard link', () => {
  it('lists screenshot filenames referenced by the finding', () => {
    const body = buildIssueBody({
      title: 'Broken', severity: 'high', category: 'links',
      screenshot: 'run_1_ab12cd34.png',
      screenshots: ['run_1_ef567890.png'],
    });
    assert.match(body, /#### Screenshots/);
    assert.match(body, /`run_1_ab12cd34\.png`/);
    assert.match(body, /`run_1_ef567890\.png`/);
  });

  it('omits the screenshots section when there are none', () => {
    const body = buildIssueBody({ title: 'X', severity: 'low', category: 'links' });
    assert.ok(!body.includes('Screenshots'));
  });

  it('adds a dashboard link when SQA_DASHBOARD_URL is set', () => {
    process.env.SQA_DASHBOARD_URL = 'https://dash.example.com/';
    const body = buildIssueBody({ title: 'X', severity: 'low' }, { runId: 'run_42' });
    assert.match(body, /\*\*Dashboard:\*\* \[view run\]\(https:\/\/dash\.example\.com\/runs\/run_42\)/);
  });

  it('has no dashboard link without the env', () => {
    const body = buildIssueBody({ title: 'X', severity: 'low' }, { runId: 'run_42' });
    assert.ok(!body.includes('Dashboard:'));
  });
});

// ─── fine vs coarse dedup in the publisher ───────────────────────────

describe('IssueTrackerPublisher — fine vs coarse signature dedup', () => {
  function makeMockAdapter(opts = {}) {
    const calls = { search: [], create: [], update: [], close: [], listOpen: [] };
    return {
      name: 'mock',
      calls,
      search: async ({ ruleId, signature }) => {
        calls.search.push({ ruleId, signature });
        if (opts.matchSignatures?.includes(signature)) {
          return { id: 'LEGACY-1', url: 'mock://1', state: 'open', title: 'Existing', labels: ['qualitypilot'] };
        }
        return null;
      },
      create: async ({ title, body, labels, severity, signature }) => {
        calls.create.push({ title, body, labels, severity, signature });
        return { id: 'NEW-' + calls.create.length, url: 'mock://new', state: 'open', title, labels };
      },
      update: async (issue, { labels, comment }) => {
        calls.update.push({ issue, labels, comment });
        return issue;
      },
      close: async (issue, { reason }) => {
        calls.close.push({ issue, reason });
        return { ...issue, state: 'closed' };
      },
      listOpen: async () => {
        calls.listOpen.push(true);
        return opts.openIssues || [];
      },
    };
  }

  const contrastFindings = [
    { ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', severity: 'medium', title: 'Low contrast', selector: '.a' },
    { ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/p', severity: 'high', title: 'Low contrast', selector: '.b' },
  ];

  it('files element-level issues for distinct elements', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({ adapter });
    const result = await publisher.publish(contrastFindings, { runId: 'run_1' });

    assert.equal(result.filed, 2);
    assert.equal(adapter.calls.create.length, 2);
    const sigs = adapter.calls.create.map((c) => c.signature);
    assert.notEqual(sigs[0], sigs[1]);
    for (const sig of sigs) {
      assert.match(sig, /^axe-color-contrast::https:\/\/example\.com\/p::/);
    }
  });

  it('dedupes by the fine signature when a matching issue exists', async () => {
    const adapter = makeMockAdapter({
      matchSignatures: [fineSignature(contrastFindings[0])],
    });
    const publisher = new IssueTrackerPublisher({ adapter });
    const result = await publisher.publish(contrastFindings, { runId: 'run_1' });

    assert.equal(result.updated, 1);
    assert.equal(result.filed, 1);
  });

  it('comments on the legacy coarse issue instead of filing while it is open', async () => {
    const coarse = findingSignature(contrastFindings[0]);
    const adapter = makeMockAdapter({ matchSignatures: [coarse] });
    const publisher = new IssueTrackerPublisher({ adapter });
    const result = await publisher.publish(contrastFindings, { runId: 'run_1' });

    // Both fine groups fell back to the same legacy issue
    assert.equal(result.updated, 2);
    assert.equal(result.legacyUpdated, 2);
    assert.equal(result.filed, 0);
    assert.equal(adapter.calls.create.length, 0);
    assert.equal(adapter.calls.update.length, 2);
    assert.match(adapter.calls.update[0].comment, /Re-occurred/);
    assert.match(adapter.calls.update[0].comment, /element/);
    // The coarse signature was searched after the fine one missed
    assert.deepEqual(adapter.calls.search.map((s) => s.signature).filter((s) => s === coarse).length >= 1, true);
  });

  it('files fine-grained issues once no legacy coarse issue is open', async () => {
    const adapter = makeMockAdapter(); // nothing matches
    const publisher = new IssueTrackerPublisher({ adapter });
    const result = await publisher.publish(contrastFindings, { runId: 'run_1' });
    assert.equal(result.filed, 2);
    assert.equal(result.legacyUpdated, 0);
  });
});

// ─── auto-close coverage guard ───────────────────────────────────────

describe('IssueTrackerPublisher — auto-close coverage guard', () => {
  function makeCloseAdapter(openIssues) {
    const calls = { close: [], listOpen: 0 };
    return {
      name: 'mock',
      calls,
      search: async () => null,
      create: async (c) => ({ id: 'NEW', url: '', state: 'open', title: c.title, labels: [] }),
      update: async (issue) => issue,
      close: async (issue, { reason }) => {
        calls.close.push({ issue, reason });
        return { ...issue, state: 'closed' };
      },
      listOpen: async () => {
        calls.listOpen++;
        return openIssues;
      },
    };
  }

  const visitedFinding = { ruleId: 'r1', pageUrl: 'https://example.com/visited', severity: 'high', title: 'V' };

  it('closes issues only on pages visited this run', async () => {
    const adapter = makeCloseAdapter([
      // rule not present in this run, but its page WAS visited → close
      { id: 1, state: 'open', title: 'Gone', labels: ['qualitypilot'], _signature: 'r9::https://example.com/visited' },
      // page NOT visited this run → must survive (coverage guard)
      { id: 2, state: 'open', title: 'Real bug on unvisited page', labels: ['qualitypilot'], _signature: 'r2::https://example.com/not-crawled' },
    ]);
    const publisher = new IssueTrackerPublisher({ adapter, options: { closeResolved: true } });

    const result = await publisher.publish([visitedFinding], {
      runId: 'run_1',
      coveredPages: ['https://example.com/visited'],
    });

    assert.equal(result.closed, 1);
    assert.equal(result.autoCloseSkipped, 1);
    assert.equal(adapter.calls.close.length, 1);
    assert.equal(adapter.calls.close[0].issue.id, 1);
  });

  it('keeps a legacy coarse issue open while its finding still re-occurs', async () => {
    const adapter = makeCloseAdapter([
      { id: 3, state: 'open', title: 'Legacy', labels: ['qualitypilot'], _signature: 'r1::https://example.com/visited' },
    ]);
    const publisher = new IssueTrackerPublisher({ adapter, options: { closeResolved: true } });
    const result = await publisher.publish([visitedFinding], {
      runId: 'run_1',
      coveredPages: ['https://example.com/visited'],
    });
    assert.equal(result.closed, 0);  // coarse signature still present via the finding
    assert.equal(adapter.calls.close.length, 0);
  });

  it('supports page objects and Sets in coveredPages', async () => {
    const adapter = makeCloseAdapter([
      { id: 1, state: 'open', title: 'Gone', labels: ['qualitypilot'], _signature: 'r1::https://example.com/visited' },
    ]);
    const publisher = new IssueTrackerPublisher({ adapter, options: { closeResolved: true } });
    await publisher.publish([], {
      runId: 'run_1',
      pages: [{ url: 'https://example.com/visited' }],
    });
    assert.equal(adapter.calls.close.length, 1);
  });

  it('skips the whole sweep when the run has no coverage info', async () => {
    const adapter = makeCloseAdapter([
      { id: 1, state: 'open', title: 'Should survive', labels: ['qualitypilot'], _signature: 'r9::https://example.com/anywhere' },
    ]);
    const publisher = new IssueTrackerPublisher({ adapter, options: { closeResolved: true } });

    const result = await publisher.publish([], { runId: 'run_1' });

    assert.equal(adapter.calls.listOpen, 0, 'listOpen never called');
    assert.equal(result.closed, 0);
    assert.equal(adapter.calls.close.length, 0);
  });

  it('partial scans (uncovered pages) never close real bugs', async () => {
    const adapter = makeCloseAdapter([
      { id: 9, state: 'open', title: 'Partial-scan survivor', labels: ['qualitypilot'], _signature: 'r2::https://example.com/not-crawled' },
    ]);
    const publisher = new IssueTrackerPublisher({ adapter, options: { closeResolved: true } });
    const result = await publisher.publish([visitedFinding], {
      runId: 'run_1',
      coveredPages: ['https://example.com/visited'],
    });
    assert.equal(result.closed, 0);
    assert.equal(result.autoCloseSkipped, 1);
  });
});

// ─── GitHub token resolution ─────────────────────────────────────────

describe('GitHubAdapter token resolution', () => {
  function makeCaptureFetch() {
    const captured = { url: null, headers: null };
    const fetch = async (url, opts = {}) => {
      captured.url = url;
      captured.headers = opts.headers || {};
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return { total_count: 0, items: [] };
        },
        async text() { return ''; },
      };
    };
    return { captured, fetch };
  }

  it('prefers SQA_GITHUB_TOKEN (README-documented name)', async () => {
    process.env.SQA_GITHUB_TOKEN = 'sqa-token';
    process.env.GITHUB_TOKEN = 'legacy-token';
    const { captured, fetch } = makeCaptureFetch();
    const adapter = new GitHubAdapter({ repo: 'foo/bar', fetch });
    await adapter.search({ ruleId: 'r', signature: 's' });
    assert.equal(captured.headers.Authorization, 'Bearer sqa-token');
  });

  it('falls back to legacy GITHUB_TOKEN when SQA_GITHUB_TOKEN is unset', async () => {
    process.env.GITHUB_TOKEN = 'legacy-token';
    const { captured, fetch } = makeCaptureFetch();
    const adapter = new GitHubAdapter({ repo: 'foo/bar', fetch });
    await adapter.search({ ruleId: 'r', signature: 's' });
    assert.equal(captured.headers.Authorization, 'Bearer legacy-token');
  });

  it('explicit constructor token wins over env', async () => {
    process.env.SQA_GITHUB_TOKEN = 'sqa-token';
    const { captured, fetch } = makeCaptureFetch();
    const adapter = new GitHubAdapter({ repo: 'foo/bar', token: 'explicit', fetch });
    await adapter.search({ ruleId: 'r', signature: 's' });
    assert.equal(captured.headers.Authorization, 'Bearer explicit');
  });

  it('throws a helpful error when no token is configured', async () => {
    const adapter = new GitHubAdapter({ repo: 'foo/bar', fetch: async () => ({}) });
    await assert.rejects(
      () => adapter.create({ title: 'X', body: 'Y', labels: [], signature: 's' }),
      (err) => /GITHUB_TOKEN not set/.test(err.message) && /SQA_GITHUB_TOKEN/.test(err.message),
    );
  });
});

// ─── Jira ADF descriptions ───────────────────────────────────────────

describe('buildAdf (Atlassian Document Format)', () => {
  it('produces a doc with one paragraph per blank-line-separated block', () => {
    const adf = buildAdf('First paragraph.\n\nSecond paragraph.');
    assert.equal(adf.type, 'doc');
    assert.equal(adf.version, 1);
    assert.equal(adf.content.length, 2);
    assert.equal(adf.content[0].type, 'paragraph');
    assert.deepEqual(adf.content[0].content, [{ type: 'text', text: 'First paragraph.' }]);
    assert.deepEqual(adf.content[1].content, [{ type: 'text', text: 'Second paragraph.' }]);
  });

  it('renders single newlines as hardBreak nodes', () => {
    const adf = buildAdf('line one\nline two');
    assert.equal(adf.content.length, 1);
    assert.deepEqual(adf.content[0].content, [
      { type: 'text', text: 'line one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'line two' },
    ]);
  });

  it('handles empty text', () => {
    const adf = buildAdf('');
    assert.equal(adf.content.length, 1);
    assert.deepEqual(adf.content[0].content, [{ type: 'text', text: '' }]);
  });
});

describe('JiraAdapter v2/v3 descriptions', () => {
  function makeCaptureFetch(routes) {
    const calls = [];
    return {
      calls,
      fetch: async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ url, method: opts.method, body });
        for (const r of routes) {
          if (r.match.test(url) && (!r.method || r.method === opts.method)) {
            return {
              status: r.status || 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              async json() { return r.body || {}; },
              async text() { return JSON.stringify(r.body || {}); },
            };
          }
        }
        throw new Error(`no mock route for ${opts.method} ${url}`);
      },
    };
  }

  it('sends an ADF description for REST v3', async () => {
    const { calls, fetch } = makeCaptureFetch([
      { match: /\/rest\/api\/3\/issue$/, method: 'POST', status: 201, body: { key: 'SQA-1' } },
      { match: /\/rest\/api\/3\/issue\/SQA-1$/, body: { key: 'SQA-1', fields: { summary: 'T', status: { statusCategory: { key: 'indeterminate' } }, description: { type: 'doc', version: 1, content: [] } } } },
    ]);
    const adapter = new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch,
    });
    assert.equal(adapter.apiVersion, 3);

    await adapter.create({ title: 'T', body: 'Body line 1\n\nBody line 2', labels: ['qualitypilot'], severity: 'high', signature: 'sig::url' });

    const desc = calls[0].body.fields.description;
    assert.equal(desc.type, 'doc');
    assert.equal(desc.version, 1);
    assert.ok(Array.isArray(desc.content));
    // Signature carried in the first paragraph for later matching
    const texts = desc.content.flatMap((p) => p.content.filter((n) => n.type === 'text').map((n) => n.text));
    assert.ok(texts.some((t) => t.includes('sig::url')));
    // Body paragraphs survive the round trip
    assert.ok(texts.includes('Body line 1'));
    assert.ok(texts.includes('Body line 2'));
  });

  it('sends a plain string description for REST v2', async () => {
    const { calls, fetch } = makeCaptureFetch([
      { match: /\/rest\/api\/2\/issue$/, method: 'POST', status: 201, body: { key: 'SQA-2' } },
      { match: /\/rest\/api\/2\/issue\/SQA-2$/, body: { key: 'SQA-2', fields: { summary: 'T', status: { statusCategory: { key: 'indeterminate' } }, description: 'plain' } } },
    ]);
    const adapter = new JiraAdapter({
      baseUrl: 'https://host/rest/api/2/', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch,
    });
    assert.equal(adapter.apiVersion, 2);

    await adapter.create({ title: 'T', body: 'Body', labels: [], severity: 'low', signature: 'sig::url' });

    assert.equal(typeof calls[0].body.fields.description, 'string');
    assert.match(calls[0].body.fields.description, /SQA Signature/);
    assert.equal(calls[0].url.includes('/rest/api/2/issue'), true);
  });

  it('sends ADF comments on v3 and string comments on v2', async () => {
    const v3 = makeCaptureFetch([
      { match: /\/comment$/, body: { id: '1' } },
    ]);
    const adapter3 = new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch: v3.fetch,
    });
    await adapter3.update({ id: 'SQA-1' }, { comment: 'Re-occurred' });
    assert.equal(v3.calls[0].body.body.type, 'doc');

    const v2 = makeCaptureFetch([
      { match: /\/comment$/, body: { id: '1' } },
    ]);
    const adapter2 = new JiraAdapter({
      baseUrl: 'https://host/rest/api/2', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch: v2.fetch,
    });
    await adapter2.update({ id: 'SQA-2' }, { comment: 'Re-occurred' });
    assert.equal(typeof v2.calls[0].body.body, 'string');
  });
});

// ─── TestRail adapter ────────────────────────────────────────────────

describe('TestRailAdapter.publishRunResults', () => {
  const run = {
    runId: 'run_77',
    url: 'https://example.com',
    score: 90,
    findings: [
      { ruleId: 'axe-color-contrast', pageUrl: 'https://example.com/pricing', severity: 'high', title: 'Low contrast', selector: '.price' },
      { ruleId: 'broken-link', pageUrl: 'https://example.com/about', severity: 'medium', title: '404 link' },
      { ruleId: 'unmapped-rule', pageUrl: 'https://example.com/other', severity: 'low', title: 'Whatever' },
    ],
  };

  function makeTestRailFetch({ runId = 555 } = {}) {
    const calls = [];
    const fetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, method: opts.method, headers: opts.headers || {}, body });
      if (url.includes('/add_run/')) {
        return { status: 200, text: async () => JSON.stringify({ id: runId, name: body?.name }) };
      }
      if (url.includes('/add_results_for_cases/')) {
        return { status: 200, text: async () => '[]' };
      }
      throw new Error(`unexpected TestRail call: ${url}`);
    };
    return { calls, fetch };
  }

  const map = {
    // coarse-style key
    'axe-color-contrast::https://example.com/pricing': 101,
    // fine signature key
    [fineSignature(run.findings[1])]: 102,
    // mapped but with no finding this run → passed
    'broken-link::https://example.com/gone': 103,
  };

  it('validates env before doing anything', async () => {
    const result = await publishToTestRail(run);
    assert.equal(result.ok, false);
    assert.match(result.error, /SQA_TESTRAIL_\* not configured/);
    assert.match(result.error, /SQA_TESTRAIL_URL/);
  });

  it('rejects a non-http(s) or plain-http URL before attaching Basic credentials (audit L-3)', async () => {
    const never = async () => { throw new Error('fetch must not be called'); };
    const badScheme = await publishToTestRail(run, { fetch: never, map, email: 'qa@example.com', apiKey: 'k', projectId: 9, url: 'ftp://files.testrail.io' });
    assert.equal(badScheme.ok, false);
    assert.match(badScheme.error, /TestRail URL rejected/);

    const plainHttp = await publishToTestRail(run, { fetch: never, map, email: 'qa@example.com', apiKey: 'k', projectId: 9, url: 'http://t.io' });
    assert.equal(plainHttp.ok, false);
    assert.match(plainHttp.error, /plain http is not allowed/);
  });

  it('creates a run with include_all:false + mapped case ids and posts results', async () => {
    const { calls, fetch } = makeTestRailFetch();
    const result = await publishToTestRail(run, { fetch, map, email: 'qa@example.com', apiKey: 'secret', projectId: 9, url: 'https://foo.testrail.io' });

    assert.equal(result.ok, true);
    assert.equal(result.testRailRunId, 555);
    assert.equal(result.failed, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.unmapped.length, 1);
    assert.match(result.unmapped[0], /^unmapped-rule::https:\/\/example\.com\/other::/);

    // Basic auth header
    const auth = calls[0].headers.Authorization;
    assert.match(auth, /^Basic /);
    assert.equal(Buffer.from(auth.replace('Basic ', ''), 'base64').toString(), 'qa@example.com:secret');

    // add_run: project in path, include_all false, mapped case ids only
    const addRun = calls.find((c) => c.url.includes('/add_run/'));
    assert.equal(addRun.url, 'https://foo.testrail.io/index.php?/api/v2/add_run/9');
    assert.equal(addRun.body.include_all, false);
    assert.deepEqual(addRun.body.case_ids, [101, 102, 103]);

    // results: 1 = passed, 5 = failed
    const resultsCall = calls.find((c) => c.url.includes('/add_results_for_cases/'));
    assert.equal(resultsCall.url, `https://foo.testrail.io/index.php?/api/v2/add_results_for_cases/555`);
    const byCase = Object.fromEntries(resultsCall.body.results.map((r) => [r.case_id, r.status_id]));
    assert.equal(byCase[101], 5);
    assert.equal(byCase[102], 5);
    assert.equal(byCase[103], 1);
    assert.match(resultsCall.body.results.find((r) => r.case_id === 101).comment, /Low contrast/);
  });

  it('does not create a run when nothing is mapped', async () => {
    const { calls, fetch } = makeTestRailFetch();
    const result = await publishToTestRail(
      { runId: 'r', findings: [{ ruleId: 'x', pageUrl: 'https://y.com/', severity: 'low', title: 'X' }] },
      { fetch, map: {}, email: 'e', apiKey: 'k', projectId: 1, url: 'https://t.io' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.testRailRunId, null);
    assert.equal(result.unmapped.length, 1);
    assert.equal(calls.length, 0);
  });

  it('redacts credentials from errors', async () => {
    const fetch = async () => ({
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: 'Invalid email or API key Authorization: Basic cXFAZXhhbXBsZS5jb206c2VjcmV0' }),
    });
    const result = await publishToTestRail(run, { fetch, map, email: 'qa@example.com', apiKey: 'supersecret', projectId: 1, url: 'https://t.io' });
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes('supersecret'), 'apiKey must be redacted');
    assert.ok(!result.error.includes('cXFAZXhhbXBsZS5jb206c2VjcmV0'), 'basic auth token must be redacted');
  });
});

// ─── Xray adapter ────────────────────────────────────────────────────

describe('XrayAdapter.publishRunResults', () => {
  const run = {
    runId: 'run_88',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:05:00.000Z',
    findings: [
      { ruleId: 'broken-link', pageUrl: 'https://example.com/about', severity: 'high', title: '404 link' },
      { ruleId: 'unmapped-rule', pageUrl: 'https://example.com/other', severity: 'low', title: 'Whatever' },
    ],
  };

  function makeXrayFetch() {
    const calls = [];
    const fetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, method: opts.method, headers: opts.headers || {}, body });
      if (url.includes('/api/v2/authenticate')) {
        return { status: 200, text: async () => JSON.stringify('JWT_TOKEN') };
      }
      if (url.includes('/api/v2/import/execution')) {
        return { status: 200, text: async () => JSON.stringify({ issues: [{ key: 'QA-EX-1', self: 'x' }] }) };
      }
      throw new Error(`unexpected Xray call: ${url}`);
    };
    return { calls, fetch };
  }

  it('validates env before doing anything', async () => {
    const result = await publishToXray(run);
    assert.equal(result.ok, false);
    assert.match(result.error, /SQA_XRAY_\* not configured/);
  });

  it('authenticates then imports a mapped-only execution', async () => {
    const { calls, fetch } = makeXrayFetch();
    const result = await publishToXray(run, {
      fetch,
      clientId: 'cid',
      clientSecret: 'csecret',
      map: {
        'broken-link::https://example.com/about': 'QA-101',
        'broken-link::https://example.com/gone': 'QA-102', // mapped, no finding → PASS
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.xrayExecutionKey, 'QA-EX-1');
    assert.equal(result.failed, 1);
    assert.equal(result.passed, 1);
    assert.equal(result.unmapped.length, 1);

    // authenticate body carries credentials
    const auth = calls[0];
    assert.equal(auth.url, 'https://xray.cloud.getxray.app/api/v2/authenticate');
    assert.deepEqual(auth.body, { client_id: 'cid', client_secret: 'csecret' });

    // import/execution carries Bearer token + jira-fields info block
    const imp = calls[1];
    assert.equal(imp.url, 'https://xray.cloud.getxray.app/api/v2/import/execution');
    assert.equal(imp.headers.Authorization, 'Bearer JWT_TOKEN');
    assert.equal(imp.body.info.summary, 'QualityPilot — run run_88');
    assert.equal(imp.body.info.start, run.startedAt);
    assert.equal(imp.body.info.finish, run.completedAt);
    const byTest = Object.fromEntries(imp.body.tests.map((t) => [t.testKey, t.status]));
    assert.equal(byTest['QA-101'], 'FAILED');
    assert.equal(byTest['QA-102'], 'PASS');
    assert.match(imp.body.tests.find((t) => t.testKey === 'QA-101').comment, /404 link/);
  });

  it('rejects an invalid Xray base URL before attaching credentials (audit L-3)', async () => {
    const never = async () => { throw new Error('fetch must not be called'); };
    const result = await publishToXray(run, { fetch: never, clientId: 'a', clientSecret: 'b', baseUrl: 'ftp://xray.internal' });
    assert.equal(result.ok, false);
    assert.match(result.error, /Xray base URL rejected/);
  });

  it('honours SQA_XRAY_BASE_URL and fails safely on auth errors', async () => {
    process.env.SQA_XRAY_BASE_URL = 'https://xray.internal';
    const fetch = async (url) => ({
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'bad client_id=abc client_secret=xyz',
    });
    const result = await publishToXray(run, { fetch, clientId: 'abc', clientSecret: 'xyz' });
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes('xyz'), 'secret must be redacted');
    assert.ok(!result.error.includes('Bearer JWT'), 'token must be redacted');
  });
});

// ─── testResultsPublisher dispatch ───────────────────────────────────

describe('testResultsPublisher', () => {
  const run = { runId: 'run_1', findings: [] };

  it('availableTargets() filters by env presence', () => {
    assert.deepEqual(availableTargets(), []);
    process.env.SQA_TESTRAIL_URL = 'https://t.io';
    process.env.SQA_TESTRAIL_EMAIL = 'e';
    process.env.SQA_TESTRAIL_API_KEY = 'k';
    assert.deepEqual(availableTargets(), [], 'project id still missing');
    process.env.SQA_TESTRAIL_PROJECT_ID = '1';
    assert.deepEqual(availableTargets(), ['testrail']);
    process.env.SQA_XRAY_CLIENT_ID = 'cid';
    assert.deepEqual(availableTargets(), ['testrail']);
    process.env.SQA_XRAY_CLIENT_SECRET = 'cs';
    assert.deepEqual(availableTargets(), ['testrail', 'xray']);
  });

  it('rejects missing/unknown targets', async () => {
    const none = await publishRunResults(run, {});
    assert.equal(none.ok, false);
    assert.match(none.error, /No target given/);

    const unknown = await publishRunResults(run, { target: 'pivotal' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unknown target: pivotal/);
  });

  it('validates env per target before dispatching', async () => {
    const tr = await publishRunResults(run, { target: 'testrail' });
    assert.equal(tr.ok, false);
    assert.match(tr.error, /SQA_TESTRAIL_\* not configured/);
    assert.match(tr.error, /SQA_TESTRAIL_EMAIL/);

    const xr = await publishRunResults(run, { target: 'xray' });
    assert.equal(xr.ok, false);
    assert.match(xr.error, /SQA_XRAY_\* not configured/);
    assert.match(xr.error, /SQA_XRAY_CLIENT_ID/);
  });

  it('dispatches to the injected adapter (dependency injection)', async () => {
    process.env.SQA_TESTRAIL_URL = 'https://t.io';
    process.env.SQA_TESTRAIL_EMAIL = 'e';
    process.env.SQA_TESTRAIL_API_KEY = 'k';
    process.env.SQA_TESTRAIL_PROJECT_ID = '1';

    let received = null;
    const fake = {
      publishRunResults: async (r, opts) => {
        received = { r, opts };
        return { ok: true, testRailRunId: 1, passed: 0, failed: 0, unmapped: [] };
      },
    };
    const result = await publishRunResults(run, { target: 'testrail', adapters: { testrail: fake }, map: {} });

    assert.equal(result.ok, true);
    assert.equal(result.testRailRunId, 1);
    assert.equal(received.r.runId, 'run_1');
    assert.equal(received.opts.target, undefined, 'target flag is not forwarded');
  });

  it('passes injected fetch through to the real adapter (end-to-end with env config)', async () => {
    process.env.SQA_TESTRAIL_URL = 'https://t.io';
    process.env.SQA_TESTRAIL_EMAIL = 'e@x.com';
    process.env.SQA_TESTRAIL_API_KEY = 'k';
    process.env.SQA_TESTRAIL_PROJECT_ID = '1';
    process.env.SQA_TESTRAIL_RUN_NAME = 'Nightly';

    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/add_run/')) return { status: 200, text: async () => JSON.stringify({ id: 9 }) };
      if (url.includes('/add_results_for_cases/')) return { status: 200, text: async () => '[]' };
      throw new Error('unexpected');
    };

    const result = await publishRunResults(
      { runId: 'run_9', findings: [] },
      { target: 'testrail', fetch, map: { 'a::https://b.com/': 5 } },
    );

    assert.equal(result.ok, true);
    assert.equal(result.testRailRunId, 9);
    assert.equal(result.passed, 1); // mapped case with no finding → passed
    assert.equal(calls[0].body.name, 'Nightly');
  });

  it('wraps adapter throws into {ok:false,error}', async () => {
    process.env.SQA_XRAY_CLIENT_ID = 'cid';
    process.env.SQA_XRAY_CLIENT_SECRET = 'cs';
    const result = await publishRunResults(run, {
      target: 'xray',
      adapters: { xray: { publishRunResults: async () => { throw new Error('boom'); } } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'boom');
  });
});
