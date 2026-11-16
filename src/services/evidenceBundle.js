/**
 * services/evidenceBundle.js — tiered evidence packages (BUILD_PLAN Phase 4).
 *
 * Every confirmed finding can be downloaded as a ZIP bundle in two tiers:
 *
 *   • Default (self-hosted, access-controlled): unredacted — screenshots,
 *     Playwright trace, video and the run's captured network traffic (HAR).
 *     The operator already controls access to their own instance.
 *
 *   • Shareable (for sending to others): scrubbed — HAR secrets/cookies/
 *     tokens are scrubbed with the MCP redaction layer, and trace/video/
 *     screenshots are REPLACED by metadata (name + size + sha256). Video and
 *     screenshots cannot be reliably redacted (they contain DOM snapshots,
 *     form values and pixels), so they are omitted and the omission is
 *     stated inside the bundle's README.
 *
 * Note on "unredacted": request/response HEADERS are redacted at capture
 * time by the crawler (Phase 0 security) — the default bundle is
 * "as-recorded", not "unscrubbed".
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from './zipWriter.js';
import { scrubText, redactFinding } from '../mcp/redact.js';

const SHAREABLE_README = `QualityPilot shareable evidence bundle
======================================

This is the SHAREABLE tier: safe to attach to an issue or send to a third party.

Included:
  * finding.json        — the finding (evidence text scrubbed for secrets)
  * har.json            — captured network traffic (HAR 1.2); cookies,
                          tokens and key-shaped values are scrubbed
  * trace-metadata.json — name/size/sha256 of the Playwright trace contents

Excluded, by design:
  * Video and screenshots — they contain DOM snapshots, form values and
    pixels that cannot be reliably redacted.
  * The Playwright trace archive itself — it embeds DOM snapshots; only its
    metadata is included here.

The DEFAULT bundle (self-hosted, access-controlled) contains everything:
trace + video + screenshots + the as-recorded HAR.
`;

const DEFAULT_README = `QualityPilot evidence bundle (default tier)
===========================================

Contents:
  * finding.json        — the finding as recorded
  * har.json            — captured network traffic (HAR 1.2, as recorded —
                          request/response header VALUES are redacted at
                          capture time by the crawler)
  * media/              — screenshots, Playwright trace (trace.zip) and
                          video when the run captured them

This bundle is for self-hosted, access-controlled use: it is NOT scrubbed
beyond the capture-time header redaction. For sharing externally use the
shareable tier (?shareable=true), which omits video/screenshots and scrubs
the HAR.
`;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build a minimal HAR 1.2 from the run's captured network calls. */
export function buildHarFromRun(run, toolVersion) {
  const entries = [];
  for (const page of run.pages || []) {
    for (const call of page.apiCalls || []) {
      const headerList = (obj) => Object.entries(obj || {}).map(([name, value]) => ({ name, value }));
      entries.push({
        pageref: page.url || undefined,
        startedDateTime: call.timestamp || run.startedAt || '',
        time: call.durationMs ?? 0,
        request: {
          method: call.method || 'GET',
          url: call.url || '',
          httpVersion: '',
          headers: headerList(call.requestHeaders),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: call.requestBody == null ? -1 : String(call.requestBody).length,
          ...(call.requestBody != null ? { postData: { mimeType: 'application/json', text: String(call.requestBody).slice(0, 4000) } } : {}),
        },
        response: {
          status: call.status ?? 0,
          statusText: '',
          httpVersion: '',
          headers: headerList(call.responseHeaders),
          cookies: [],
          content: {
            size: call.responseBody == null ? -1 : String(call.responseBody).length,
            mimeType: call.responseContentType || '',
            ...(call.responseBody != null ? { text: String(call.responseBody).slice(0, 4000) } : {}),
          },
          headersSize: -1,
          bodySize: -1,
          redirectURL: '',
        },
        cache: {},
        timings: { send: 0, wait: call.durationMs ?? 0, receive: 0 },
      });
    }
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'QualityPilot', version: toolVersion || '' },
      pages: (run.pages || []).map((p) => ({
        startedDateTime: run.startedAt || '',
        id: p.url || '',
        title: p.title || p.url || '',
        pageTimings: {},
      })),
      entries,
    },
  };
}

/** Scrub secrets from a HAR: urls, header values, post data — entry by entry so JSON structure survives. */
export function scrubHar(har) {
  const clone = JSON.parse(JSON.stringify(har));
  for (const entry of clone.log?.entries || []) {
    entry.request.url = scrubText(entry.request.url || '');
    for (const h of entry.request.headers || []) h.value = scrubText(h.value || '');
    for (const h of entry.response.headers || []) h.value = scrubText(h.value || '');
    if (entry.request.postData?.text) entry.request.postData.text = scrubText(entry.request.postData.text);
    if (entry.response.content?.text) entry.response.content.text = scrubText(entry.response.content.text);
  }
  return clone;
}

/** List media artifacts referenced by a finding (screenshot/trace/video), resolving paths under evidenceDir. */
export function findingMediaFiles(finding, evidenceDir) {
  const files = [];
  if (finding.screenshot && fs.existsSync(finding.screenshot)) {
    files.push({ name: `media/${path.basename(finding.screenshot)}`, path: finding.screenshot });
  }
  const ref = finding.evidenceRef;
  if (ref?.cellId && evidenceDir) {
    // matrixRunner writes cell evidence under cellDirName(cell.id) — ':' is
    // illegal in NTFS directory names. Sanitize identically when reading back.
    const cellDir = path.join(evidenceDir, String(ref.cellId).replace(/:/g, '-'));
    const tracePath = path.join(cellDir, 'trace.zip');
    if (ref.hasTrace && fs.existsSync(tracePath)) {
      files.push({ name: 'media/trace.zip', path: tracePath });
    }
    const videoDir = path.join(cellDir, 'video');
    if (ref.hasVideo && fs.existsSync(videoDir)) {
      for (const f of fs.readdirSync(videoDir)) {
        const p = path.join(videoDir, f);
        if (fs.statSync(p).isFile()) files.push({ name: `media/video/${f}`, path: p });
      }
    }
  }
  return files;
}

/**
 * Build the evidence bundle for one finding.
 *
 * @param {object} p
 * @param {object} p.run — the run record (pages, apiCalls, startedAt)
 * @param {object} p.finding — the finding object (must carry `id`)
 * @param {string} [p.evidenceDir] — the run's evidence dir (media resolution)
 * @param {boolean} [p.shareable=false] — build the scrubbed shareable tier
 * @param {string} [p.toolVersion]
 * @returns {{ buffer: Buffer, filename: string, entryNames: string[] }}
 */
export function buildFindingEvidenceBundle({ run, finding, evidenceDir, shareable = false, toolVersion }) {
  if (!finding) throw new Error('buildFindingEvidenceBundle: finding is required');

  const entries = [{ name: 'README.txt', data: shareable ? SHAREABLE_README : DEFAULT_README }];

  // finding.json — shareable tier scrubs the finding text.
  entries.push({
    name: 'finding.json',
    data: JSON.stringify(shareable ? redactFinding(finding, 'full') : finding, null, 2),
  });

  // HAR — shareable tier scrubs secrets entry-by-entry.
  const har = buildHarFromRun(run, toolVersion);
  entries.push({ name: 'har.json', data: JSON.stringify(shareable ? scrubHar(har) : har, null, 2) });

  // Media: default tier includes everything captured; shareable replaces
  // trace/video/screenshots with metadata only.
  const media = findingMediaFiles(finding, evidenceDir);
  if (!shareable) {
    for (const m of media) {
      entries.push({ name: m.name, data: fs.readFileSync(m.path) });
    }
  } else if (media.length > 0) {
    const meta = media.map((m) => {
      const buf = fs.readFileSync(m.path);
      return { name: m.name, bytes: buf.length, sha256: sha256(buf) };
    });
    entries.push({ name: 'trace-metadata.json', data: JSON.stringify({
      note: 'Media omitted from shareable bundles — cannot be reliably redacted. Metadata only.',
      files: meta,
    }, null, 2) });
  }

  const filename = `evidence-${finding.id || 'finding'}${shareable ? '-shareable' : ''}.zip`;
  return { buffer: createZip(entries), filename, entryNames: entries.map((e) => e.name) };
}
