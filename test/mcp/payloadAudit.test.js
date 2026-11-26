process.env.NODE_ENV = 'test';

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMcpReport, enforceMcpPayloadBudget, estimateTokens } from '../../src/mcp/reporting.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-mcp-payload-'));
process.env.SQA_MCP_ARTIFACTS_DIR = path.join(tmpDir, 'artifacts');

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('WS4.3 — MCP payload budget and disk artifact compaction', () => {
  it('caps large scan reports below 2,000 tokens and persists the complete redacted report to disk', async () => {
    const findings = Array.from({ length: 45 }, (_, i) => ({
      id: `BUG-${String(i + 1).padStart(3, '0')}`,
      title: `Seeded defect #${i + 1} with long diagnostic title for budget check`,
      severity: i < 5 ? 'critical' : i < 15 ? 'high' : 'medium',
      confidence: 'confirmed',
      category: 'security',
      findingType: 'bug',
      ruleId: `rule-seeded-${i + 1}`,
      pageUrl: `https://example.com/route/${i + 1}`,
      selector: `#el-${i + 1}`,
      description: 'Detailed finding description explaining failure mode and security impact.',
      evidence: 'Evidence payload '.repeat(25),
      suggestedFix: 'Apply the documented remediation in handler configuration.',
    }));

    const run = {
      runId: 'run_mcp_bulky_test',
      url: 'https://example.com/',
      status: 'completed',
      score: 42,
      coverage: { pagesAttempted: 45, pagesScanned: 45, coverageRatio: 1 },
      findings,
    };

    const { report, validation } = buildMcpReport(run, { verbosity: 'full' });
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.ok(report, 'report built cleanly');
    assert.equal(report.truncated, true);
    assert.ok(report.artifactPath && existsSync(report.artifactPath), 'full report artifact written to disk');

    const wireTokens = estimateTokens(JSON.stringify(report));
    assert.ok(wireTokens <= 2000, `Expected <= 2000 tokens, got ${wireTokens}`);
    assert.equal(report.summary.confirmedBugs, 45);
    assert.equal(report.truncatedCounts.confirmedTotal, 45);
    assert.ok(report.confirmed.length > 0, 'keeps top-severity findings inline');
    assert.ok(['critical', 'high'].includes(report.confirmed[0].severity), 'prioritizes highest severities inline');

    // Disk artifact retains ALL 45 findings + full redacted evidence
    const onDisk = JSON.parse(await fs.readFile(report.artifactPath, 'utf8'));
    assert.equal(onDisk.confirmed.length, 45);
    assert.ok(onDisk.confirmed[0].evidence.includes('Evidence payload'));
  });

  it('enforceMcpPayloadBudget returns compact verdict unchanged when already within budget', () => {
    const small = { pass: true, url: 'https://example.com/', confirmedCount: 0, confirmed: [] };
    const out = enforceMcpPayloadBudget(small, { runId: 'small_run' });
    assert.equal(out.truncated, undefined);
    assert.equal(out.artifactPath, undefined);
  });
});
