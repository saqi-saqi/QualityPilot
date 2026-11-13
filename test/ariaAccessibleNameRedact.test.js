import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAriaSnapshot } from '../src/explorer/prompts.js';

describe('Phase 2: Heading & Control Accessible Name PII Redaction Test', () => {
  it('redacts PII from headings, link titles, and button accessible names', () => {
    const rawYaml = `
- heading "Welcome back, Johnathan Doe" [level=1]
- link "Order ORD-998877665544332211 details" [ref=e1]
- button "Reorder ORD-998877665544332211" [ref=e2]
    `.trim();

    const sanitized = sanitizeAriaSnapshot(rawYaml);

    // Assert that neither the name "Johnathan Doe" nor the order ID "ORD-998877665544332211" appears anywhere
    assert.doesNotMatch(sanitized, /Johnathan Doe/, 'Customer name must be scrubbed from heading');
    assert.doesNotMatch(sanitized, /ORD-998877665544332211/, 'Order ID must be scrubbed from link & button');

    // Confirm that the structural lines with sanitized placeholders are retained
    assert.match(sanitized, /heading "Welcome back, \[NAME_REDACTED\]" \[level=1\]/);
    assert.match(sanitized, /link "Order \[ORDER_REDACTED\] details" \[ref=e1\]/);
    assert.match(sanitized, /button "Reorder \[ORDER_REDACTED\]" \[ref=e2\]/);
  });
});
