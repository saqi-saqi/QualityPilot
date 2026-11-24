/**
 * executors/visual.js — visual regression via screenshot pixel-diff.
 *
 * Consumes: plan.visualBaselines[]
 * Produces: findings when a page's screenshot differs from baseline > threshold
 *
 * Strategy:
 *   1. For each baseline, navigate the page, set viewport, mask dynamic
 *      elements (defaults: [data-dynamic], time, [datetime], .advertisement,
 *      .adsbygoogle — unless the plan specifies maskSelectors).
 *   2. Capture a FULL-PAGE screenshot (below-the-fold layout breaks must be
 *      visible). When the plan explicitly lists viewports, a viewport-only
 *      capture runs as a second comparison.
 *   3. Resolve the baseline image: plan.baselinePath (legacy) or the
 *      persisted baselineStore (monitorId + pageUrl + viewport + label).
 *      - baseline exists → diff; within threshold → pass (no finding);
 *        over threshold → `visual-regression` finding + diff PNG
 *        (grayscale current, differing pixels painted red).
 *      - no baseline → capture + saveBaseline + info "baseline created".
 *   4. Dimension mismatches are NOT reported as 100% diff: they emit a
 *      low-severity `visual-dimensions-changed` finding and fall back to
 *      comparing the overlapping region.
 *
 * PNG decode/encode is implemented here on top of node:zlib (no image
 * library dependency): 8-bit depth, color types 0/2/3/4/6, non-interlaced —
 * the formats Playwright's `screenshot({ type: 'png' })` produces. The diff
 * functions stay pure so tests can verify threshold math without files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { config } from '../utils/config.js';
import { waitForPageReady } from '../utils/pageReady.js';

// Baseline persistence — another module (src/storage/baselineStore.js) owns
// the store. Required defensively: if it isn't present at runtime we fall
// back to the plan-baselinePath behavior.
let baselineStore = null;
let baselineStoreTried = false;
async function getBaselineStore() {
  if (!baselineStoreTried) {
    baselineStoreTried = true;
    try {
      baselineStore = await import('../storage/baselineStore.js');
    } catch {
      baselineStore = null;
    }
  }
  return baselineStore && typeof baselineStore.getLatestBaseline === 'function' ? baselineStore : null;
}

/** Default mask selectors for dynamic content (ads, timestamps). */
export const DEFAULT_MASK_SELECTORS = '[data-dynamic], time, [datetime], .advertisement, .adsbygoogle';

// ─── PNG codec (8-bit, non-interlaced) ───────────────────────────────

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer to raw RGBA pixels.
 * Supports bit depth 8, color types 0 (gray), 2 (rgb), 3 (palette),
 * 4 (gray+alpha), 6 (rgba); non-interlaced.
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
export function decodePng(buffer) {
  if (!buffer || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG buffer (bad signature)');
  }
  let offset = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }

  if (!ihdr) throw new Error('PNG missing IHDR chunk');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${ihdr.bitDepth}`);
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[ihdr.colorType];
  if (!channels) throw new Error(`unsupported PNG color type: ${ihdr.colorType}`);
  if (ihdr.colorType === 3 && !palette) throw new Error('palette PNG missing PLTE chunk');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data truncated');

  // Unfilter scanlines
  const unfiltered = Buffer.alloc(stride * height);
  let prevStart = -1; // offset of previous row in unfiltered
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowStart + x];
      const left = x >= channels ? unfiltered[outStart + x - channels] : 0;
      const up = y > 0 ? unfiltered[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? unfiltered[prevStart + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + left; break;
        case 2: val = rawByte + up; break;
        case 3: val = rawByte + ((left + up) >> 1); break;
        case 4: val = rawByte + paethPredictor(left, up, upLeft); break;
        default: throw new Error(`unsupported PNG filter: ${filter}`);
      }
      unfiltered[outStart + x] = val & 0xff;
    }
    prevStart = outStart;
  }

  // Expand to RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    switch (ihdr.colorType) {
      case 0: // grayscale
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = unfiltered[src];
        rgba[dst + 3] = 255;
        break;
      case 2: // rgb
        rgba[dst] = unfiltered[src];
        rgba[dst + 1] = unfiltered[src + 1];
        rgba[dst + 2] = unfiltered[src + 2];
        rgba[dst + 3] = 255;
        break;
      case 3: { // palette
        const idx = unfiltered[src];
        rgba[dst] = palette[idx * 3];
        rgba[dst + 1] = palette[idx * 3 + 1];
        rgba[dst + 2] = palette[idx * 3 + 2];
        rgba[dst + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
        break;
      }
      case 4: // gray + alpha
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = unfiltered[src];
        rgba[dst + 3] = unfiltered[src + 1];
        break;
      case 6: // rgba
        rgba[dst] = unfiltered[src];
        rgba[dst + 1] = unfiltered[src + 1];
        rgba[dst + 2] = unfiltered[src + 2];
        rgba[dst + 3] = unfiltered[src + 3];
        break;
    }
  }

  return { width, height, rgba };
}

/** Encode raw RGBA pixels as a PNG buffer (8-bit RGBA, filter 0). */
export function encodePng(rgba, width, height) {
  if (!rgba || rgba.length < width * height * 4) {
    throw new Error('encodePng: rgba buffer smaller than width*height*4');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace

  // Prepend filter byte 0 to each scanline
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── pixel diffing ───────────────────────────────────────────────────

/**
 * Pure-function diff: given two raw RGBA pixel buffers of IDENTICAL size,
 * compute the fraction of differing pixels (luminance tolerance 30/255).
 *
 * @param {Buffer} actual    — raw RGBA pixel data of the actual screenshot
 * @param {Buffer} baseline  — raw RGBA pixel data of the baseline screenshot
 * @returns {{ diffRatio: number, diffPixelCount: number }}
 */
export function computePixelDiff(actual, baseline) {
  if (!actual || !baseline) {
    return { diffRatio: 1.0, diffPixelCount: -1 };
  }
  if (actual.length !== baseline.length) {
    // Different dimensions = total diff (callers should use the
    // decodePng + overlap path for a dimension-aware comparison)
    return { diffRatio: 1.0, diffPixelCount: -1 };
  }
  const pixelCount = actual.length / 4;
  let diffPixels = 0;
  for (let i = 0; i < actual.length; i += 4) {
    // Use luminance diff with a tolerance of 30 (out of 255)
    const aLum = 0.299 * actual[i] + 0.587 * actual[i + 1] + 0.114 * actual[i + 2];
    const bLum = 0.299 * baseline[i] + 0.587 * baseline[i + 1] + 0.114 * baseline[i + 2];
    if (Math.abs(aLum - bLum) > 30) {
      diffPixels++;
    }
  }
  return { diffRatio: diffPixels / pixelCount, diffPixelCount: diffPixels };
}

/**
 * Dimension-aware diff: decode both PNGs and compare only the OVERLAPPING
 * region (top-left aligned). Used as the resize-compare fallback when the
 * current capture and the stored baseline have different dimensions.
 * Returns { width, height, diffRatio, diffPixelCount } | null (undecodable).
 */
export function computeOverlapDiff(actualPng, baselinePng) {
  let actual, baseline;
  try {
    actual = decodePng(actualPng);
    baseline = decodePng(baselinePng);
  } catch {
    return null;
  }
  const width = Math.min(actual.width, baseline.width);
  const height = Math.min(actual.height, baseline.height);
  if (width === 0 || height === 0) {
    return { width, height, diffRatio: 1, diffPixelCount: width * height };
  }
  const actualOverlap = extractRegion(actual, width, height);
  const baselineOverlap = extractRegion(baseline, width, height);
  const { diffRatio, diffPixelCount } = computePixelDiff(actualOverlap, baselineOverlap);
  return { width, height, diffRatio, diffPixelCount };
}

/** Copy a top-left w×h region of a decoded PNG into a compact RGBA buffer. */
function extractRegion(img, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcStart = y * img.width * 4;
    img.rgba.copy(out, y * width * 4, srcStart, srcStart + width * 4);
  }
  return out;
}

/**
 * Build the diff image: grayscale the CURRENT image and paint every pixel
 * that differs from the baseline (beyond luminance tolerance) red.
 * Only the overlapping region is represented. Returns a PNG buffer.
 */
export function buildDiffImage(actualPng, baselinePng) {
  const actual = decodePng(actualPng);
  const baseline = decodePng(baselinePng);
  const width = Math.min(actual.width, baseline.width);
  const height = Math.min(actual.height, baseline.height);
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * actual.width + x) * 4;
      const baseIdx = (y * baseline.width + x) * 4;
      const dstIdx = (y * width + x) * 4;
      const aLum = Math.round(0.299 * actual.rgba[srcIdx] + 0.587 * actual.rgba[srcIdx + 1] + 0.114 * actual.rgba[srcIdx + 2]);
      const bLum = Math.round(0.299 * baseline.rgba[baseIdx] + 0.587 * baseline.rgba[baseIdx + 1] + 0.114 * baseline.rgba[baseIdx + 2]);
      if (Math.abs(aLum - bLum) > 30) {
        out[dstIdx] = 255;     // differing pixel → red
        out[dstIdx + 1] = 0;
        out[dstIdx + 2] = 0;
        out[dstIdx + 3] = 255;
      } else {
        out[dstIdx] = out[dstIdx + 1] = out[dstIdx + 2] = aLum; // grayscale current
        out[dstIdx + 3] = 255;
      }
    }
  }
  return encodePng(out, width, height);
}

/**
 * Compare a captured screenshot against a baseline image buffer.
 * Handles dimension mismatches honestly: instead of reporting 100% diff,
 * returns { dimensionsChanged, overlap? } so the caller can emit the
 * distinct `visual-dimensions-changed` finding and use the overlap result.
 */
export function compareScreenshots(actualPng, baselinePng) {
  let actual, baseline;
  try {
    actual = decodePng(actualPng);
    baseline = decodePng(baselinePng);
  } catch {
    // Undecodable (e.g. JPEG or truncated) — fall back to legacy buffer diff
    const { diffRatio, diffPixelCount } = computePixelDiff(actualPng, baselinePng);
    return { dimensionsChanged: actualPng?.length !== baselinePng?.length, diffRatio, diffPixelCount };
  }
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    const overlap = computeOverlapDiff(actualPng, baselinePng);
    return {
      dimensionsChanged: true,
      actualDimensions: { width: actual.width, height: actual.height },
      baselineDimensions: { width: baseline.width, height: baseline.height },
      ...(overlap ? { overlap } : {}),
    };
  }
  const { diffRatio, diffPixelCount } = computePixelDiff(actual.rgba, baseline.rgba);
  return { dimensionsChanged: false, diffRatio, diffPixelCount };
}

// ─── capture ─────────────────────────────────────────────────────────

/**
 * Capture a screenshot from a Playwright page with the given viewport
 * + masked elements. Captures FULL PAGE by default (below-the-fold layout
 * breaks must be visible); pass { fullPage: false } for a viewport-only
 * comparison shot.
 */
export async function captureScreenshot(page, baseline, screenshotsDir, runId, opts = {}) {
  const fullPage = opts.fullPage !== false;

  // Set viewport if the page supports it (Playwright Page.setViewportSize)
  if (typeof page.setViewportSize === 'function') {
    await page.setViewportSize({ width: baseline.viewport.width, height: baseline.viewport.height });
  }

  await page.goto(baseline.pageUrl, { waitUntil: 'load', timeout: config?.pageTimeoutMs || 30000 });

  // Apply masks — mask selectors are CSS selectors whose area should be
  // excluded from the diff (ads, dynamic content, etc.). Plans that specify
  // their own maskSelectors win; otherwise the sensible dynamic-content
  // defaults apply.
  const maskSelectors = baseline.maskSelectors?.length
    ? baseline.maskSelectors
    : [DEFAULT_MASK_SELECTORS];
  const maskOptions = {};
  if (typeof page.locator === 'function') {
    maskOptions.mask = maskSelectors.map(s => page.locator(s));
  }

  // Ensure loading indicators and running animations settle before pixel capture.
  // We set networkIdle: false because page.goto(..., { waitUntil: 'load' }) has already settled network load.
  await waitForPageReady(page, { timeoutMs: 3000, networkIdle: false });

  const buffer = await page.screenshot({
    type: 'png',
    fullPage,
    ...maskOptions,
  });

  // Hash for tracking — useful in findings
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);

  // Filename: {runId}_{pageSlug}_{viewportName}_{hash}.png
  const slug = baseline.pageUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-50);
  const suffix = fullPage ? '' : '_viewport';
  const filename = `${runId}_${slug}_${baseline.viewport.name || 'default'}${suffix}_${hash}.png`;
  const filepath = path.join(screenshotsDir, filename);
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.writeFile(filepath, buffer);

  return { buffer, filepath, hash };
}

// ─── main executor entry ─────────────────────────────────────────────

function viewportKey(viewport) {
  if (!viewport) return 'default';
  return viewport.name || `${viewport.width}x${viewport.height}`;
}

function scopeIdFor(ctx) {
  // monitorId scopes baselines for monitored runs; one-off runs key on runId
  return ctx.options?.monitorId || ctx.monitorId || ctx.runId || 'default';
}

/** Main executor entry — registered as 'visual' in the registry. */
export default async function visualExecutor(ctx) {
  if (!ctx.context) {
    ctx.onEvent?.('visual skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const baselines = ctx.plan?.visualBaselines || [];
  const findings = [];
  const store = await getBaselineStore();
  const scopeId = scopeIdFor(ctx);
  // A second, viewport-only comparison runs only when the plan explicitly
  // lists viewports (opt-in).
  const doViewportCompare = Array.isArray(ctx.plan?.viewports) && ctx.plan.viewports.length > 0;

  ctx.onEvent?.(`Capturing/comparing ${baselines.length} visual baselines${store ? ' (baseline store available)' : ''}`);

  for (const baseline of baselines) {
    if (ctx.signal?.aborted) break;

    if (ctx.isPageFailed?.(baseline.pageUrl)) {
      ctx.recordPageFailure?.({ url: baseline.pageUrl, executor: 'visual' });
      continue;
    }

    const page = await ctx.context.newPage();
    // Audit L-1 (same defect as e2e): BrowserContext.newPage() takes no
    // viewport argument — apply the baseline viewport explicitly.
    if (baseline.viewport && typeof page.setViewportSize === 'function') {
      await page.setViewportSize({ width: baseline.viewport.width, height: baseline.viewport.height }).catch(() => {});
    }
    try {
      const { buffer, filepath, hash } = await captureScreenshot(
        page, baseline, ctx.screenshotsDir, ctx.runId
      );

      // Resolve the baseline to compare against:
      //   1. plan.baselinePath (legacy, explicit)
      //   2. persisted baselineStore row (monitorId + pageUrl + viewport + label)
      let baselinePath = baseline.baselinePath || null;
      let baselineFromStore = false;
      if (!baselinePath && store) {
        try {
          const row = await store.getLatestBaseline(
            scopeId, baseline.pageUrl, viewportKey(baseline.viewport), baseline.label || 'default'
          );
          if (row?.path) {
            baselinePath = row.path;
            baselineFromStore = true;
          }
        } catch { /* store read failed — treat as no baseline */ }
      }

      if (baselinePath) {
        let baselineBuffer;
        try {
          baselineBuffer = await fs.readFile(baselinePath);
        } catch {
          baselineBuffer = null;
        }

        if (!baselineBuffer) {
          // Baseline reference missing — treat as first run + persist
          if (store) {
            await saveBaselineQuietly(store, {
              scopeId, baseline, filepath, hash, ctx,
            });
          }
          findings.push(baselineCreatedFinding(ctx, baseline, filepath));
          continue;
        }

        const comparison = compareScreenshots(buffer, baselineBuffer);
        const threshold = baseline.threshold ?? 0.01;

        if (comparison.dimensionsChanged) {
          // Don't report 100% diff on dimension mismatch — a distinct,
          // low-severity finding with both dimensions + overlap fallback.
          const overlap = comparison.overlap;
          const overlapOverThreshold = overlap && overlap.diffRatio > threshold;
          findings.push(ctx.createFinding({
            title: `Visual dimensions changed: ${baseline.pageUrl} (${baseline.viewport.name || 'default'})`,
            severity: 'low',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'warning',
            origin: 'first-party',
            ruleId: 'visual-dimensions-changed',
            pageUrl: baseline.pageUrl,
            description: `Screenshot dimensions changed from ${comparison.baselineDimensions.width}x${comparison.baselineDimensions.height} (baseline) to ${comparison.actualDimensions.width}x${comparison.actualDimensions.height} (current). The overlapping region was compared instead of auto-failing.`,
            evidence: `Baseline: ${baselinePath}${baselineFromStore ? ' (baseline store)' : ''}\nActual: ${filepath}\nBaseline dimensions: ${comparison.baselineDimensions.width}x${comparison.baselineDimensions.height}\nActual dimensions: ${comparison.actualDimensions.width}x${comparison.actualDimensions.height}${overlap ? `\nOverlapping region (${overlap.width}x${overlap.height}) diff: ${(overlap.diffRatio * 100).toFixed(2)}% (${overlap.diffPixelCount} px)` : '\nOverlap comparison unavailable (undecodable image)'}`,
            screenshot: filepath,
            suggestedFix: 'If the layout change is intentional (e.g. new content), re-baseline the page. Otherwise investigate the size change.',
          }));
          if (overlapOverThreshold && overlap) {
            const diffFilepath = await writeDiffImage(ctx, buffer, baselineBuffer, baseline, 'overlap');
            findings.push(ctx.createFinding({
              title: `Visual regression (overlapping region): ${baseline.pageUrl} (${baseline.viewport.name || 'default'})`,
              severity: 'medium',
              confidence: 'confirmed',
              category: 'network',
              findingType: 'bug',
              origin: 'first-party',
              ruleId: 'visual-regression',
              pageUrl: baseline.pageUrl,
              description: `Pixel diff ${(overlap.diffRatio * 100).toFixed(2)}% of the overlapping region (${overlap.width}x${overlap.height}) exceeds threshold ${(threshold * 100).toFixed(2)}%. Dimensions changed, so only the shared region was compared.`,
              evidence: `Baseline: ${baselinePath}${baselineFromStore ? ' (baseline store)' : ''}\nActual: ${filepath}\nDiff image: ${diffFilepath || 'unavailable'}\nDiff pixels: ${overlap.diffPixelCount} / ${(overlap.diffRatio * 100).toFixed(2)}%`,
              ...(diffFilepath ? { screenshot: diffFilepath } : {}),
              suggestedFix: 'If the change is intentional, update the baseline. Otherwise, restore the original layout.',
            }));
          }
          continue;
        }

        if (comparison.diffRatio > threshold) {
          const diffFilepath = await writeDiffImage(ctx, buffer, baselineBuffer, baseline, 'diff');
          findings.push(ctx.createFinding({
            title: `Visual regression: ${baseline.pageUrl} (${baseline.viewport.name || 'default'})`,
            severity: 'medium',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'visual-regression',
            pageUrl: baseline.pageUrl,
            description: `Pixel diff ${(comparison.diffRatio * 100).toFixed(2)}% exceeds threshold ${(threshold * 100).toFixed(2)}%.`,
            evidence: `Baseline: ${baselinePath}${baselineFromStore ? ' (baseline store)' : ''}\nActual: ${filepath}\nDiff image: ${diffFilepath || 'unavailable'}\nDiff pixels: ${comparison.diffPixelCount} / ${(comparison.diffRatio * 100).toFixed(2)}%`,
            ...(diffFilepath ? { screenshot: diffFilepath } : {}),
            suggestedFix: 'If the change is intentional, update the baseline. Otherwise, restore the original layout.',
          }));
        }

        // Second comparison — viewport-only, when the plan lists viewports.
        if (doViewportCompare) {
          try {
            const viewportShot = await captureScreenshot(page, baseline, ctx.screenshotsDir, ctx.runId, { fullPage: false });
            const viewportComparison = compareScreenshots(viewportShot.buffer, baselineBuffer);
            if (!viewportComparison.dimensionsChanged && viewportComparison.diffRatio > threshold) {
              findings.push(ctx.createFinding({
                title: `Visual regression (viewport): ${baseline.pageUrl} (${baseline.viewport.name || 'default'})`,
                severity: 'low',
                confidence: 'confirmed',
                category: 'network',
                findingType: 'warning',
                origin: 'first-party',
                ruleId: 'visual-regression-viewport',
                pageUrl: baseline.pageUrl,
                description: `Viewport-only capture differs from baseline by ${(viewportComparison.diffRatio * 100).toFixed(2)}% (threshold ${(threshold * 100).toFixed(2)}%). The full-page comparison above remains the authoritative result.`,
                evidence: `Baseline: ${baselinePath}${baselineFromStore ? ' (baseline store)' : ''}\nActual (viewport): ${viewportShot.filepath}\nDiff pixels: ${viewportComparison.diffPixelCount} / ${(viewportComparison.diffRatio * 100).toFixed(2)}%`,
                screenshot: viewportShot.filepath,
              }));
            }
          } catch { /* viewport-only comparison is best-effort */ }
        }
      } else {
        // First run — this screenshot IS the new baseline. Persist it so
        // future runs diff against it instead of re-baselining forever.
        if (store) {
          await saveBaselineQuietly(store, { scopeId, baseline, filepath, hash, ctx });
        } else {
          ctx.onEvent?.(`No baseline store available — baseline for ${baseline.pageUrl} captured at ${filepath} (not persisted; set plan.baselinePath or provide baselineStore)`);
        }
        findings.push(baselineCreatedFinding(ctx, baseline, filepath));
      }
    } catch (err) {
      if (ctx.recordPageFailure) {
        ctx.recordPageFailure({ url: baseline.pageUrl, error: err.message, executor: 'visual' });
      } else {
        findings.push(ctx.createFinding({
          title: `Page load failed: ${baseline.pageUrl}`,
          severity: 'info',
          confidence: 'high',
          category: 'Scan Coverage',
          findingType: 'coverage-failure',
          origin: 'first-party',
          ruleId: 'page-load-failure',
          pageUrl: baseline.pageUrl,
          description: err.message,
          evidence: err.message,
          blockedExecutors: ['visual'],
        }));
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`visual complete: ${findings.length} findings`);
  return { findings, stats: { baselines: baselines.length, captured: findings.filter(f => f.ruleId === 'visual-baseline-captured').length } };
}

async function saveBaselineQuietly(store, { scopeId, baseline, filepath, hash, ctx }) {
  try {
    await store.saveBaseline({
      monitorId: scopeId,
      pageUrl: baseline.pageUrl,
      viewport: viewportKey(baseline.viewport),
      label: baseline.label || 'default',
      path: filepath,
      hash,
    });
    ctx.onEvent?.(`Baseline persisted for ${baseline.pageUrl} (${viewportKey(baseline.viewport)})`);
  } catch (err) {
    ctx.onEvent?.(`Failed to persist baseline for ${baseline.pageUrl}: ${err.message}`);
  }
}

function baselineCreatedFinding(ctx, baseline, filepath) {
  return ctx.createFinding({
    title: `Visual baseline created: ${baseline.pageUrl}`,
    severity: 'info',
    confidence: 'confirmed',
    category: 'network',
    findingType: 'informational',
    origin: 'first-party',
    // ruleId kept as 'visual-baseline-captured' — mcp/rules.js and the
    // dashboard key on it; the behavior change (persist + only-once) is
    // what's new, not the identifier.
    ruleId: 'visual-baseline-captured',
    pageUrl: baseline.pageUrl,
    description: `First-run baseline stored at ${filepath}. Future runs will diff against this instead of re-baselining.`,
    screenshot: filepath,
  });
}

/** Write the visual diff PNG (grayscale current + red differing pixels). */
async function writeDiffImage(ctx, currentBuffer, baselineBuffer, baseline, kind) {
  try {
    const diffPng = buildDiffImage(currentBuffer, baselineBuffer);
    const slug = baseline.pageUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-50);
    const filename = `${ctx.runId || 'run'}_${slug}_${baseline.viewport.name || 'default'}_${kind}.png`;
    await fs.mkdir(ctx.screenshotsDir, { recursive: true });
    const filepath = path.join(ctx.screenshotsDir, filename);
    await fs.writeFile(filepath, diffPng);
    return filepath;
  } catch {
    return null;
  }
}
