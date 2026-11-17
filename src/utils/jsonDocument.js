/**
 * utils/jsonDocument.js — extract the first top-level JSON document from
 * mixed CLI output.
 *
 * `qualitypilot check` prints human progress lines around its JSON document
 * (banner, scan progress, trailing gate line). Files captured by redirecting
 * that output therefore contain log noise around the JSON. This scanner
 * finds the first line that is exactly `{` and returns the balanced top-level
 * object, honoring strings and escapes.
 *
 * Also used by the Phase 6 `--baseline` loader so baselines captured the old
 * way (mixed output) still load.
 *
 * Throws:
 *   • 'No JSON document found in scan output' — no `{` line present
 *   • 'JSON document in scan output is truncated' — unbalanced document
 */

export function extractJsonDocument(text) {
  // Tolerate a BOM (UTF-8 BOM survives utf8 decoding as \uFEFF; UTF-16 files
  // decoded as utf16le keep theirs too).
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const start = clean.search(/^\{\s*$/m);
  if (start === -1) throw new Error('No JSON document found in scan output');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('JSON document in scan output is truncated');
  return JSON.parse(clean.slice(start, end));
}

/**
 * Decode a captured-output Buffer that may be UTF-8 or UTF-16LE (PowerShell's
 * `>` redirection writes UTF-16LE with BOM). Returns a clean JS string.
 */
export function decodeCapturedOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}
