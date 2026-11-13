import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAriaSnapshot } from '../src/explorer/prompts.js';

describe('Phase 2: ARIA Snapshot Secret & Form Sanitization', () => {
  it('masks passwords, card numbers, and sensitive fields as [SECRET_REDACTED]', () => {
    const rawYaml = `
- heading "Login Form" [level=1]
- textbox "Username" [ref=e1]: user@example.com
- textbox "Password" [ref=e2]: SuperSecretPassword123!
- textbox "Credit Card" [ref=e3]: 4111-2222-3333-4444
- textbox "CVV" [ref=e4]: 123
- textbox "SSN" [ref=e5]: 000-12-3456
- button "Submit" [ref=e6]
    `.trim();

    const sanitized = sanitizeAriaSnapshot(rawYaml);

    // Verify sensitive secrets are masked
    assert.doesNotMatch(sanitized, /SuperSecretPassword123!/);
    assert.doesNotMatch(sanitized, /4111-2222-3333-4444/);
    assert.doesNotMatch(sanitized, /\b123\b/);
    assert.doesNotMatch(sanitized, /000-12-3456/);

    // Verify appropriate redaction tokens appear
    assert.match(sanitized, /textbox "Password" \[ref=e2\]:\s*\[SECRET_REDACTED\]/);
    assert.match(sanitized, /textbox "Credit Card" \[ref=e3\]:\s*\[SECRET_REDACTED\]/);
    assert.match(sanitized, /textbox "CVV" \[ref=e4\]:\s*\[SECRET_REDACTED\]/);
    assert.match(sanitized, /textbox "SSN" \[ref=e5\]:\s*\[SECRET_REDACTED\]/);

    // Verify standard textbox value is masked as [VALUE_REDACTED]
    assert.match(sanitized, /textbox "Username" \[ref=e1\]:\s*\[VALUE_REDACTED\]/);
    assert.doesNotMatch(sanitized, /user@example\.com/);
  });
});
