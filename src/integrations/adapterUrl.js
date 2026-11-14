/**
 * integrations/adapterUrl.js — URL validation for operator-configured
 * issue-tracker adapters (Jira baseUrl, GitHub absolute pagination URLs).
 *
 * Deliberate deviation from BUILD_PLAN Phase 0's "route adapters through
 * safeFetch": Jira/GitHub baseUrls are operator-configured and may
 * legitimately point at self-hosted LAN instances (e.g. a Jira on
 * http://jira.lan:8080), which safeFetch's private-IP blocking would break.
 * The actual flagged gap was "no URL validation at all" — these adapters
 * attach credentials (Basic auth / Bearer token) to whatever URL they are
 * given — so we validate shape and scheme instead of IP:
 *
 *   • must parse as an absolute URL (new URL)
 *   • scheme must be http: or https: (file:, ftp:, data:, … rejected)
 *   • https: is required unless SQA_ALLOW_INSECURE_ADAPTER_HTTP=1
 *     (documented escape hatch for self-hosted LAN Jira over plain HTTP)
 */

const INSECURE_HTTP_OPT_OUT = 'SQA_ALLOW_INSECURE_ADAPTER_HTTP';

/**
 * Validate a URL that is about to carry adapter credentials.
 *
 * @param {string} rawUrl
 * @returns {{ok: true, url: URL} | {ok: false, error: string}}
 */
export function validateAdapterUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, error: 'URL must be a non-empty string' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: `not a valid absolute URL: "${rawUrl}"` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      error: `unsupported scheme "${parsed.protocol}" — only http/https are allowed`,
    };
  }
  if (
    parsed.protocol !== 'https:' &&
    process.env[INSECURE_HTTP_OPT_OUT] !== '1'
  ) {
    return {
      ok: false,
      error:
        `plain http is not allowed for authenticated adapter requests — use https, ` +
        `or set ${INSECURE_HTTP_OPT_OUT}=1 to allow a self-hosted LAN instance`,
    };
  }
  return { ok: true, url: parsed };
}
