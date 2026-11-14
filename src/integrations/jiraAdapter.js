/**
 * integrations/jiraAdapter.js — Jira adapter for issue tracking.
 *
 * Uses Jira Cloud REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/).
 * Auth: email + API token via Basic auth.
 *
 * Required env:
 *   JIRA_BASE_URL — e.g. https://your-domain.atlassian.net
 *   JIRA_EMAIL    — your Atlassian account email
 *   JIRA_API_TOKEN — API token from https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Or pass via constructor.
 *
 * API version handling: the `description` field differs between versions.
 * REST v3 requires Atlassian Document Format (ADF) — a JSON tree built by
 * buildAdf() below. REST v2 accepts a plain wiki-markup string. We detect
 * the version from the configured base URL: if it contains `rest/api/2`
 * we speak v2 (plain strings); anything else defaults to v3 (ADF).
 */

import { validateAdapterUrl } from './adapterUrl.js';

const SEVERITY_TO_PRIORITY = {
  critical: '1',  // Highest
  high:     '2',
  medium:   '3',
  low:      '4',
  info:     '5',  // Lowest
};

/**
 * Build an Atlassian Document Format (ADF) document from plain text.
 *
 * - Text is split on blank lines (\n\n) into paragraphs.
 * - Single newlines inside a paragraph become ADF hardBreak nodes.
 *
 * @param {string} text
 * @returns {{type:'doc', version:number, content:Array}}
 */
export function buildAdf(text) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const content = (paragraphs.length ? paragraphs : ['']).map((paragraph) => {
    const lines = paragraph.split('\n');
    const nodeContent = [];
    lines.forEach((line, i) => {
      if (i > 0) nodeContent.push({ type: 'hardBreak' });
      nodeContent.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content: nodeContent };
  });

  return { type: 'doc', version: 1, content };
}

/**
 * Render the signed issue body for the configured API version.
 * v2 → plain wiki-markup string (the {panel} macro); v3 → ADF document
 * whose first paragraph carries the SQA signature.
 */
function renderDescription(apiVersion, signedBody, signature) {
  if (apiVersion === 2) return signedBody;
  const header = buildAdf(`SQA Signature\n${signature}`);
  const body = buildAdf(signedBody);
  return {
    type: 'doc',
    version: 1,
    content: [...header.content, ...body.content],
  };
}

export class JiraAdapter {
  /**
   * @param {object} options
   * @param {string} options.baseUrl     — Jira base URL (may include /rest/api/2 or /rest/api/3)
   * @param {string} options.email
   * @param {string} options.apiToken
   * @param {string} options.projectKey   — e.g. 'SQA'
   * @param {object} [options.fetch]
   */
  constructor({ baseUrl, email, apiToken, projectKey, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new Error('JiraAdapter requires baseUrl');
    if (!email) throw new Error('JiraAdapter requires email');
    if (!apiToken) throw new Error('JiraAdapter requires apiToken');
    if (!projectKey) throw new Error('JiraAdapter requires projectKey');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Phase 0 Fix D: fail fast on the operator-configured baseUrl — this URL
    // receives the Basic auth header, so non-http(s) schemes (file:, data:, …)
    // and plain http must be rejected before any request is ever built.
    const baseUrlCheck = validateAdapterUrl(this.baseUrl);
    if (!baseUrlCheck.ok) {
      throw new Error(`JiraAdapter: invalid baseUrl — ${baseUrlCheck.error}`);
    }
    this.email = email;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    // v2 accepts plain-string descriptions; v3 requires ADF.
    this.apiVersion = /rest\/api\/2/.test(this.baseUrl) ? 2 : 3;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error('No fetch implementation available');

    // Pre-encode Basic auth header
    this._authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  async _api(method, path, body) {
    // Paths must start with "/" (all internal API paths do). A foreign-scheme
    // path like "file:/…" would otherwise be silently string-concatenated into
    // `${baseUrl}file:/…` — a valid https URL for a DIFFERENT host that would
    // still receive the Basic auth header.
    if (!path.startsWith('/')) {
      throw new Error(`JiraAdapter: refusing to send authenticated request — path must start with "/": "${path}"`);
    }
    const url = `${this.baseUrl}${path}`;
    // Second line of defense (the constructor already validated baseUrl):
    // refuse to send authenticated requests to a URL that fails validation.
    const urlCheck = validateAdapterUrl(url);
    if (!urlCheck.ok) {
      throw new Error(`JiraAdapter: refusing to send authenticated request — ${urlCheck.error}`);
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        'Authorization': this._authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;
    if (res.status >= 400) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(`Jira API ${res.status}: ${errBody.errorMessages?.join('; ') || res.statusText}`);
      err.status = res.status;
      err.body = errBody;
      throw err;
    }

    return res.json();
  }

  /**
   * Search for an existing open Jira issue by signature.
   * Uses JQL: project = SQA AND signature ~ "ruleId::url" AND statusCategory != Done
   */
  async search({ ruleId, signature }) {
    if (!signature) return null;
    const jql = `project = ${this.projectKey} AND statusCategory != Done AND description ~ "${signature}" ORDER BY created DESC`;

    try {
      const data = await this._api('POST', `/rest/api/${this.apiVersion}/search`, {
        jql,
        maxResults: 1,
        fields: ['summary', 'status', 'description', 'priority', 'labels'],
      });

      if (!data.issues || data.issues.length === 0) return null;
      return this._normalizeIssue(data.issues[0]);
    } catch (err) {
      if (err.status === 400) return null;  // bad JQL or no results
      throw err;
    }
  }

  /**
   * Create a new Jira issue.
   * description: ADF document for REST v3, plain string for REST v2.
   */
  async create({ title, body, labels, severity, signature }) {
    const signedBody = `{panel:title=SQA Signature|borderStyle=dashed}\n${signature}\n{panel}\n\n${body}`;

    const data = await this._api('POST', `/rest/api/${this.apiVersion}/issue`, {
      fields: {
        project: { key: this.projectKey },
        summary: title,
        description: renderDescription(this.apiVersion, signedBody, signature),
        labels: labels || [],
        priority: { id: SEVERITY_TO_PRIORITY[severity] || SEVERITY_TO_PRIORITY.medium },
        issuetype: { name: 'Bug' },
      },
    });

    // Fetch the full issue to get a normalized shape
    const full = await this._api('GET', `/rest/api/${this.apiVersion}/issue/${data.key}`);
    return this._normalizeIssue(full);
  }

  /**
   * Update an existing Jira issue — add a comment + optionally update labels.
   * Comments follow the same v2/v3 split as descriptions.
   */
  async update(issue, { labels, comment }) {
    if (comment) {
      await this._api('POST', `/rest/api/${this.apiVersion}/issue/${issue.id}/comment`, {
        body: this.apiVersion === 2
          ? comment
          : buildAdf(comment),
      });
    }

    if (labels) {
      await this._api('PUT', `/rest/api/${this.apiVersion}/issue/${issue.id}`, {
        fields: { labels },
      });
    }

    return issue;
  }

  /**
   * Close a Jira issue — transition to "Done" status.
   */
  async close(issue, { reason = 'completed' } = {}) {
    // Get available transitions for this issue
    const transitionsRes = await this._api('GET', `/rest/api/${this.apiVersion}/issue/${issue.id}/transitions`);

    const doneTransition = transitionsRes.transitions?.find(t =>
      /^done|closed|resolved$/i.test(t.name) || t.to?.statusCategory?.key === 'done'
    );

    if (!doneTransition) {
      throw new Error(`No "Done" transition available for issue ${issue.id}`);
    }

    await this._api('POST', `/rest/api/${this.apiVersion}/issue/${issue.id}/transitions`, {
      transition: { id: doneTransition.id },
    });

    return { ...issue, state: 'closed' };
  }

  /**
   * List all open issues in this project with the sqa-agent label.
   */
  async listOpen() {
    const jql = `project = ${this.projectKey} AND statusCategory != Done AND labels = "sqa-agent" ORDER BY created DESC`;
    const data = await this._api('POST', `/rest/api/${this.apiVersion}/search`, {
      jql,
      maxResults: 100,
      fields: ['summary', 'status', 'description', 'priority', 'labels'],
    });

    return (data.issues || []).map(this._normalizeIssue);
  }

  /**
   * Normalize a raw Jira issue into the adapter issue shape.
   * Note: `description` comes back as a plain string from REST v2 but as an
   * Atlassian Document Format (ADF) JSON tree from REST v3 —
   * extractJiraSignature() handles both shapes when pulling the signature.
   */
  _normalizeIssue(raw) {
    return {
      id: raw.key,  // e.g. 'SQA-123'
      url: `${this.baseUrl}/browse/${raw.key}`,
      state: raw.fields?.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
      title: raw.fields?.summary,
      labels: raw.fields?.labels || [],
      _signature: extractJiraSignature(raw.fields?.description || ''),
    };
  }
}

/**
 * Walk an ADF document and collect the text of every `text` node,
 * joined with newlines.
 */
function adfToText(doc) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text);
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  };
  walk(doc);
  return out.join('\n');
}

/**
 * Extract the SQA signature from a Jira description.
 *
 * REST v2 descriptions are plain strings (wiki markup with the signature
 * panel); REST v3 descriptions are ADF JSON trees. Both are handled here.
 */
function extractJiraSignature(description) {
  if (!description) return null;

  // v2 / legacy: plain string with the "SQA Signature" panel
  if (typeof description === 'string') {
    const m = description.match(/SQA Signature[^{]*\n([^\n]+)/);
    if (m) return m[1].trim();
    // Fallback: any line carrying a `rule::value` signature token
    return firstSignatureToken(description.split('\n'));
  }

  // v3: ADF object — collect its text and find the signature token
  try {
    return firstSignatureToken(adfToText(description).split('\n'));
  } catch {
    return null;
  }
}

/**
 * Find the first line that contains a `something::value` signature token
 * and return the token (from the start of the word preceding the first `::`).
 */
function firstSignatureToken(lines) {
  for (const line of lines) {
    const idx = line.indexOf('::');
    if (idx === -1) continue;
    let start = idx;
    while (start > 0 && !/\s/.test(line[start - 1])) start--;
    const token = line.slice(start).trim();
    if (token) return token;
  }
  return null;
}

export { extractJiraSignature };
