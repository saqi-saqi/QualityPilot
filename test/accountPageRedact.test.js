import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAriaSnapshot } from '../src/explorer/prompts.js';

describe('Phase 2: Account Page PII Elimination Test', () => {
  it('completely drops standalone paragraphs and body text nodes containing customer PII', () => {
    const rawYaml = `
- heading "Account Dashboard" [level=1]
- paragraph: "Customer Name: Johnathan Doe"
- text: 742 Evergreen Terrace, Sector 4
- paragraph: "Recent Order: ORD-998877665544332211"
- button "Edit Profile" [ref=e1]
- button "Sign Out" [ref=e2]
    `.trim();

    const sanitized = sanitizeAriaSnapshot(rawYaml);

    // Assert that NONE of the customer name, address, or order number appear anywhere
    assert.doesNotMatch(sanitized, /Johnathan Doe/, 'Customer name must not appear in prompt output');
    assert.doesNotMatch(sanitized, /742 Evergreen Terrace/, 'Street address must not appear in prompt output');
    assert.doesNotMatch(sanitized, /ORD-998877665544332211/, 'Order ID must not appear in prompt output');

    // Structural whitelisted controls should remain
    assert.match(sanitized, /heading "Account Dashboard" \[level=1\]/);
    assert.match(sanitized, /button "Edit Profile" \[ref=e1\]/);
    assert.match(sanitized, /button "Sign Out" \[ref=e2\]/);
  });
});
