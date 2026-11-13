/**
 * Workflow / flow request validation — preserved from the old routes/runs.js
 * suite (that Express router is gone; the same workflow-step rules now live
 * in the TestPlan Flow schema, which both the dashboard and runManager use).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlowSchema as Flow, parseTestPlan } from '../src/services/testPlan.js';

const basePlan = {
  schemaVersion: 1,
  id: 'plan_workflows',
  targetUrl: 'https://example.com',
  flows: [{
    name: 'Search',
    startUrl: 'https://example.com',
    steps: [{ action: 'assertVisible', selector: 'main' }],
  }],
};

describe('workflow flow validation (TestPlan Flow schema)', () => {
  it('accepts a bounded, explicit browser assertion workflow', () => {
    const plan = parseTestPlan(basePlan);
    assert.equal(plan.flows[0].name, 'Search');
  });

  it('validates a flow object directly through the Flow schema', () => {
    const parsed = Flow.parse({
      name: 'Search',
      startUrl: 'https://example.com',
      steps: [{ action: 'assertVisible', selector: 'main' }],
    });
    assert.equal(parsed.name, 'Search');
  });

  it('rejects selector actions without a selector', () => {
    const invalid = structuredClone(basePlan);
    invalid.flows[0].steps = [{ action: 'click' }];
    assert.throws(() => parseTestPlan(invalid));
  });

  it('rejects assertions without the value they need', () => {
    const invalid = structuredClone(basePlan);
    invalid.flows[0].steps = [{ action: 'assertUrl' }];
    assert.throws(() => parseTestPlan(invalid));
  });

  it('accepts upload workflow steps', () => {
    const upload = {
      schemaVersion: 1,
      id: 'plan_upload',
      targetUrl: 'https://example.com',
      flows: [{
        name: 'Upload',
        startUrl: 'https://example.com/upload',
        steps: [{ action: 'upload', selector: 'input[type="file"]', value: 'C:/test.txt' }],
      }],
    };
    assert.equal(parseTestPlan(upload).flows[0].steps[0].action, 'upload');
  });

  it('accepts api-request flow steps with method + url + expectations', () => {
    const plan = parseTestPlan({
      ...basePlan,
      flows: [{
        name: 'API probe',
        startUrl: 'https://example.com',
        steps: [{
          action: 'api-request',
          method: 'GET',
          url: 'https://example.com/api/health',
          headers: { Accept: 'application/json' },
          expectStatus: 200,
          expectJsonPath: '$.status',
          saveAsVar: 'health',
        }],
      }],
    });
    const step = plan.flows[0].steps[0];
    assert.equal(step.action, 'api-request');
    assert.equal(step.method, 'GET');
    assert.equal(step.saveAsVar, 'health');
  });

  it('rejects api-request steps without a url', () => {
    assert.throws(() => parseTestPlan({
      ...basePlan,
      flows: [{
        name: 'API probe',
        startUrl: 'https://example.com',
        steps: [{ action: 'api-request', method: 'GET' }],
      }],
    }));
  });

  it('accepts flows flagged needsReview / allowCrossOrigin by the inferrer', () => {
    const plan = parseTestPlan({
      ...basePlan,
      flows: [{
        ...basePlan.flows[0],
        allowCrossOrigin: true,
        needsReview: true,
      }],
    });
    assert.equal(plan.flows[0].allowCrossOrigin, true);
    assert.equal(plan.flows[0].needsReview, true);
  });
});
