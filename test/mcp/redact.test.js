import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, sanitizeError, redactFinding } from '../../src/mcp/redact.js';

describe('scrubText — credential patterns', () => {
  it('scrubs Bearer tokens, JWTs, cookies and key=value secrets', () => {
    const input = 'Authorization: Bearer abc123def456\n' +
      'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n' +
      'cookie: session=super-secret-value; other=x\n' +
      'api_key = "sk-live-abcdef123456"';
    const out = scrubText(input);
    assert.doesNotMatch(out, /abc123def456/);
    assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiIs/);
    assert.doesNotMatch(out, /super-secret-value/);
    assert.doesNotMatch(out, /sk-live-abcdef123456/);
    assert.match(out, /\[REDACTED\]/);
  });

  it('scrubs bare session/sid/phpsessid/csrf key names', () => {
    const input = 'session=abc12345 sid=xyz999 phpsessid=qwerty1234 csrf=token-999 ' +
      'PHPSESSID=aa11bb22cc33';
    const out = scrubText(input);
    assert.doesNotMatch(out, /abc12345/);
    assert.doesNotMatch(out, /xyz999/);
    assert.doesNotMatch(out, /qwerty1234/);
    assert.doesNotMatch(out, /token-999/);
    assert.doesNotMatch(out, /aa11bb22cc33/);
  });

  it('does not redact ordinary words containing sid/session', () => {
    const out = scrubText('the president visits the sessional committee');
    assert.match(out, /president/);
    assert.match(out, /visits/);
  });

  it('scrubs GitHub token prefixes', () => {
    const input = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz gho_0123456789abcdefghijklmnopqrstuvwxyz ' +
      'github_pat_11ABCDEFG0_0123456789012345678901234567890';
    const out = scrubText(input);
    assert.doesNotMatch(out, /ghp_0123456789/);
    assert.doesNotMatch(out, /gho_0123456789/);
    assert.doesNotMatch(out, /github_pat_11ABCDEFG0/);
    assert.match(out, /\[REDACTED_GITHUB_TOKEN\]/g);
  });

  it('scrubs OpenAI-style sk- keys', () => {
    const bare = scrubText('sk-proj-abcdefghij0123456789');
    assert.doesNotMatch(bare, /sk-proj-abcdefghij0123456789/);
    assert.match(bare, /\[REDACTED_API_KEY\]/);

    // With a key name in front, the generic key=value scrub catches it first
    const withPrefix = scrubText('key: sk-proj-abcdefghij0123456789');
    assert.doesNotMatch(withPrefix, /sk-proj-abcdefghij0123456789/);
  });

  it('scrubs Slack xox[bap] tokens', () => {
    const token = ['xoxb', '123456789', 'abcdefghijklmnop'].join('-');
    const out = scrubText(token);
    assert.doesNotMatch(out, /xoxb-123456789/);
    assert.match(out, /\[REDACTED_SLACK_TOKEN\]/);
  });

  it('scrubs AWS access key ids (AKIA)', () => {
    const out = scrubText('AKIAIOSFODNN7EXAMPLE');
    assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
    assert.match(out, /\[REDACTED_AWS_KEY\]/);
  });

  it('scrubs generic key/token/secret/password assignments', () => {
    const input = 'password=hunter2 and token: abc123 and secret="s3cr3t"';
    const out = scrubText(input);
    assert.doesNotMatch(out, /hunter2/);
    assert.doesNotMatch(out, /abc123/);
    assert.doesNotMatch(out, /s3cr3t/);
  });

  it('redacts token-like strings of 24+ chars but leaves shorter prose alone', () => {
    const out = scrubText('ref refresh_tokenvalue_abc12345678 kept shortval12345');
    assert.match(out, /\[REDACTED_TOKEN\]/);
    assert.match(out, /kept shortval12345/); // 13 chars — untouched
  });

  it('sanitizeError never returns stack frames', () => {
    const err = new Error('boom at /src/x.js:12:5');
    err.stack = 'Error: boom\n    at foo (/src/x.js:12:5)\n    at bar (/src/y.js:3:1)';
    const out = sanitizeError(err);
    assert.doesNotMatch(out, /at foo|at bar/);
    assert.doesNotMatch(out, /\n {4}at /);
  });
});

describe('redactFinding', () => {
  const finding = {
    id: 'F-1',
    ruleId: 'axe-image-alt',
    title: 'Missing alt text',
    severity: 'serious',
    confidence: 'confirmed',
    pageUrl: 'https://example.com/page?password=hunter2',
    description: 'Failed with session=aa11bb22cc33',
    evidence: 'Authorization: Bearer abc123def456789',
    suggestedFix: 'Add an alt attribute',
    affectedPages: ['https://example.com/a'],
    affectedElements: ['<img src="https://x/y?session=aa11bb22cc33">', '<img class="logo">'],
    reproSteps: ['Navigate to /', 'Run scan with sid=zz99'],
    metrics: {
      scanned: 12,
      breakdown: { pages: 10, nested: ['ok', 'tokenvalue_abc1234567890'] },
    },
  };

  it('summary verbosity omits evidence blobs', () => {
    const out = redactFinding(finding, 'summary');
    assert.equal(out.evidence, undefined);
    assert.equal(out.description, undefined);
    assert.ok(!JSON.stringify(out).includes('abc123def456789'));
  });

  it('full verbosity scrubs affectedElements (strings, arrays) through scrubText', () => {
    const out = redactFinding(finding, 'full');
    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, /aa11bb22cc33/);
    assert.ok(Array.isArray(out.affectedElements));
    assert.match(out.affectedElements[0], /\[REDACTED\]/);
    assert.match(out.affectedElements[1], /<img class="logo">/);
    assert.match(out.reproSteps[1], /\[REDACTED\]/);
  });

  it('full verbosity keeps numeric affectedElements as numbers', () => {
    const out = redactFinding({ ...finding, affectedElements: 7 }, 'full');
    assert.equal(out.affectedElements, 7);
  });

  it('scrubMetrics recurses into nested objects and arrays', () => {
    const out = redactFinding(finding, 'full');
    assert.equal(out.metrics.scanned, 12);
    assert.equal(out.metrics.breakdown.pages, 10);
    assert.equal(out.metrics.breakdown.nested[0], 'ok');
    assert.doesNotMatch(out.metrics.breakdown.nested[1], /tokenvalue_abc1234567890/);
    assert.match(out.metrics.breakdown.nested[1], /\[REDACTED_TOKEN\]/);
  });
});
