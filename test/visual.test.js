import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePixelDiff,
  encodePng,
  decodePng,
  compareScreenshots,
  buildDiffImage,
  DEFAULT_MASK_SELECTORS,
  default as visualExecutor,
} from '../src/executors/visual.js';
import { createFindingFactory } from '../src/services/findingFactory.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Helper: build an RGBA pixel buffer of N pixels with the given color
function pixelBuffer(count, [r, g, b, a = 255]) {
  const buf = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe('computePixelDiff', () => {
  it('returns 0 diff for identical buffers', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(100, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 0);
    assert.equal(result.diffPixelCount, 0);
  });

  it('returns ~1 diff for completely different colors', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(100, [255, 255, 255]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, 100);
  });

  it('returns diff:1 when buffer lengths differ', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(50, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, -1);
  });

  it('returns diff:1 when either buffer is null', () => {
    const a = pixelBuffer(10, [0, 0, 0]);
    assert.equal(computePixelDiff(null, a).diffRatio, 1);
    assert.equal(computePixelDiff(a, null).diffRatio, 1);
    assert.equal(computePixelDiff(null, null).diffRatio, 1);
  });

  it('does NOT flag small luminance differences (within tolerance)', () => {
    const a = pixelBuffer(10, [100, 100, 100]);
    const b = pixelBuffer(10, [110, 110, 110]);  // delta=10, within tolerance of 30
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 0);
  });

  it('flags luminance differences above tolerance', () => {
    const a = pixelBuffer(10, [100, 100, 100]);
    const b = pixelBuffer(10, [200, 200, 200]);  // delta=100, exceeds tolerance of 30
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, 10);
  });

  it('handles partial differences', () => {
    // 5 black + 5 white vs 10 black = 5 diff pixels
    const a = Buffer.concat([pixelBuffer(5, [0, 0, 0]), pixelBuffer(5, [255, 255, 255])]);
    const b = pixelBuffer(10, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffPixelCount, 5);
    assert.equal(result.diffRatio, 0.5);
  });
});

// ─── PNG codec ───────────────────────────────────────────────────────

describe('PNG codec (encodePng/decodePng)', () => {
  function sampleImage() {
    const w = 4, h = 2;
    const rgba = Buffer.alloc(w * h * 4);
    const px = (i, r, g, b, a = 255) => { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a; };
    px(0, 255, 0, 0); px(1, 0, 255, 0); px(2, 0, 0, 255); px(3, 255, 255, 255);
    px(4, 10, 10, 10); px(5, 128, 128, 128); px(6, 200, 100, 50); px(7, 0, 0, 0);
    return { w, h, rgba };
  }

  it('round-trips raw RGBA through encode/decode', () => {
    const { w, h, rgba } = sampleImage();
    const decoded = decodePng(encodePng(rgba, w, h));
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual([...decoded.rgba], [...rgba]);
  });

  it('throws on non-PNG input', () => {
    assert.throws(() => decodePng(Buffer.from('not a png')), /bad signature/i);
    assert.throws(() => decodePng(null), /bad signature/i);
  });

  it('produces buffers with a valid PNG signature', () => {
    const { w, h, rgba } = sampleImage();
    const png = encodePng(rgba, w, h);
    assert.equal(png[0], 137);
    assert.equal(png[1], 80);
    assert.equal(png[2], 78);
    assert.equal(png[3], 71);
  });
});

// ─── dimension-aware comparison ──────────────────────────────────────

describe('compareScreenshots (dimension mismatch handling)', () => {
  function solidPng(w, h, [r, g, b]) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return encodePng(rgba, w, h);
  }

  it('reports identical images as 0 diff', () => {
    const a = solidPng(4, 4, [10, 20, 30]);
    const cmp = compareScreenshots(a, a);
    assert.equal(cmp.dimensionsChanged, false);
    assert.equal(cmp.diffRatio, 0);
  });

  it('does NOT report 100% diff on dimension mismatch — reports both dimensions', () => {
    const actual = solidPng(4, 4, [0, 0, 0]);
    const baseline = solidPng(8, 6, [0, 0, 0]);
    const cmp = compareScreenshots(actual, baseline);
    assert.equal(cmp.dimensionsChanged, true);
    assert.deepEqual(cmp.actualDimensions, { width: 4, height: 4 });
    assert.deepEqual(cmp.baselineDimensions, { width: 8, height: 6 });
    // Overlap fallback compares the top-left 4x4 region (identical → 0 diff)
    assert.ok(cmp.overlap);
    assert.equal(cmp.overlap.diffRatio, 0);
    assert.equal(cmp.overlap.width, 4);
    assert.equal(cmp.overlap.height, 4);
  });

  it('compares the overlapping region when content differs there', () => {
    const actual = solidPng(4, 4, [0, 0, 0]);
    const baseline = solidPng(8, 6, [255, 255, 255]);
    const cmp = compareScreenshots(actual, baseline);
    assert.equal(cmp.dimensionsChanged, true);
    assert.equal(cmp.overlap.diffRatio, 1);
  });
});

// ─── diff image ──────────────────────────────────────────────────────

describe('buildDiffImage (grayscale + red differing pixels)', () => {
  it('grayscales identical regions and paints differing pixels red', () => {
    const w = 2, h = 1;
    const actualRgba = Buffer.alloc(w * h * 4);
    // pixel 0: green (will change), pixel 1: gray 100 (unchanged)
    actualRgba[0] = 0; actualRgba[1] = 255; actualRgba[2] = 0; actualRgba[3] = 255;
    actualRgba[4] = 100; actualRgba[5] = 100; actualRgba[6] = 100; actualRgba[7] = 255;
    const baselineRgba = Buffer.from(actualRgba);
    baselineRgba[0] = 255; baselineRgba[2] = 0; // pixel 0 becomes red → huge luminance shift

    const diffPng = buildDiffImage(encodePng(actualRgba, w, h), encodePng(baselineRgba, w, h));
    const diff = decodePng(diffPng);
    // pixel 0 → pure red
    assert.equal(diff.rgba[0], 255);
    assert.equal(diff.rgba[1], 0);
    assert.equal(diff.rgba[2], 0);
    // pixel 1 → grayscale luminance of (100,100,100) = 100
    assert.equal(diff.rgba[4], 100);
    assert.equal(diff.rgba[5], 100);
    assert.equal(diff.rgba[6], 100);
  });
});

// ─── default mask selectors ──────────────────────────────────────────

describe('default mask selectors', () => {
  it('exposes the dynamic-content default mask', () => {
    assert.ok(DEFAULT_MASK_SELECTORS.includes('[data-dynamic]'));
    assert.ok(DEFAULT_MASK_SELECTORS.includes('time'));
    assert.ok(DEFAULT_MASK_SELECTORS.includes('[datetime]'));
    assert.ok(DEFAULT_MASK_SELECTORS.includes('.advertisement'));
    assert.ok(DEFAULT_MASK_SELECTORS.includes('.adsbygoogle'));
  });
});

// ─── executor: baseline + regression + diff image + dimensions ──────

describe('visualExecutor with mock context', () => {
  function solidPng(w, h, [r, g, b]) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return encodePng(rgba, w, h);
  }

  function mockPage(screenshotBuffer) {
    return {
      async setViewportSize() {},
      async goto() {},
      locator() { return {}; },
      async screenshot() { return screenshotBuffer; },
      async close() {},
    };
  }

  function makeCtx({ screenshotBuffer, baselinePlan = {}, viewports } = {}) {
    return {
      plan: {
        targetUrl: 'https://example.com',
        visualBaselines: [{
          pageUrl: 'https://example.com/page',
          viewport: { width: 10, height: 10, name: 'desktop' },
          maskSelectors: [],
          threshold: 0.01,
          ...baselinePlan,
        }],
        ...(viewports ? { viewports } : {}),
      },
      context: { async newPage() { return mockPage(screenshotBuffer); } },
      createFinding: createFindingFactory(),
      onEvent: () => {},
      screenshotsDir: null,
      runId: 'run_visual_test',
      options: {},
    };
  }

  async function withTmpDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqa-vis-'));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('creates a baseline on first run — info finding, no regression', async () => {
    await withTmpDir(async (dir) => {
      const ctx = makeCtx({ screenshotBuffer: solidPng(4, 4, [10, 10, 10]) });
      ctx.screenshotsDir = dir;
      const result = await visualExecutor(ctx);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].ruleId, 'visual-baseline-captured');
      assert.equal(result.findings[0].severity, 'info');
      assert.ok(result.findings[0].evidence === '' || result.findings[0].description.includes('Future runs will diff'));
    });
  });

  it('emits visual-regression with a diff image when the diff exceeds the threshold', async () => {
    await withTmpDir(async (dir) => {
      const baselineFile = path.join(dir, 'baseline.png');
      await fs.writeFile(baselineFile, solidPng(4, 4, [0, 0, 0]));

      const ctx = makeCtx({
        screenshotBuffer: solidPng(4, 4, [255, 255, 255]),  // totally different
        baselinePlan: { baselinePath: baselineFile },
      });
      ctx.screenshotsDir = dir;
      const result = await visualExecutor(ctx);

      const regressions = result.findings.filter(f => f.ruleId === 'visual-regression');
      assert.equal(regressions.length, 1);
      assert.equal(regressions[0].severity, 'medium');
      assert.equal(regressions[0].confidence, 'confirmed');
      assert.match(regressions[0].evidence, /Diff image:/);
      // Both images referenced in evidence
      assert.match(regressions[0].evidence, /Baseline: .*baseline\.png/);
      assert.match(regressions[0].evidence, /Actual: /);
      // The diff image file actually exists and is a PNG
      const diffPath = regressions[0].evidence.match(/Diff image: (.*)/)[1].trim();
      const diffBuf = await fs.readFile(diffPath);
      assert.equal(diffBuf[0], 137);
    });
  });

  it('passes silently when within threshold (no finding)', async () => {
    await withTmpDir(async (dir) => {
      const baselineFile = path.join(dir, 'baseline.png');
      await fs.writeFile(baselineFile, solidPng(4, 4, [100, 100, 100]));

      const ctx = makeCtx({
        screenshotBuffer: solidPng(4, 4, [110, 110, 110]),  // within tolerance 30
        baselinePlan: { baselinePath: baselineFile },
      });
      ctx.screenshotsDir = dir;
      const result = await visualExecutor(ctx);
      assert.equal(result.findings.length, 0);
    });
  });

  it('emits visual-dimensions-changed (low severity) + overlap comparison instead of auto-fail', async () => {
    await withTmpDir(async (dir) => {
      const baselineFile = path.join(dir, 'baseline.png');
      await fs.writeFile(baselineFile, solidPng(8, 6, [0, 0, 0]));

      const ctx = makeCtx({
        screenshotBuffer: solidPng(4, 4, [0, 0, 0]),  // different dims, same overlapping content
        baselinePlan: { baselinePath: baselineFile },
      });
      ctx.screenshotsDir = dir;
      const result = await visualExecutor(ctx);

      const dimFindings = result.findings.filter(f => f.ruleId === 'visual-dimensions-changed');
      assert.equal(dimFindings.length, 1);
      assert.equal(dimFindings[0].severity, 'low');
      assert.match(dimFindings[0].evidence, /8x6/);
      assert.match(dimFindings[0].evidence, /4x4/);
      // No 100% visual-regression auto-fail for identical overlapping content
      assert.equal(result.findings.filter(f => f.ruleId === 'visual-regression').length, 0);
    });
  });

  it('uses plan maskSelectors when given, defaults otherwise', async () => {
    await withTmpDir(async (dir) => {
      const seenMasks = [];
      const page = {
        async setViewportSize() {},
        async goto() {},
        locator(sel) { seenMasks.push(sel); return { sel }; },
        async screenshot() { return solidPng(4, 4, [5, 5, 5]); },
        async close() {},
      };
      const ctx = makeCtx({ screenshotBuffer: solidPng(4, 4, [5, 5, 5]) });
      ctx.screenshotsDir = dir;
      ctx.context = { async newPage() { return page; } };
      await visualExecutor(ctx);
      // No plan masks → the default dynamic-content mask applies
      assert.deepEqual(seenMasks, [DEFAULT_MASK_SELECTORS]);

      seenMasks.length = 0;
      const ctx2 = makeCtx({ screenshotBuffer: solidPng(4, 4, [5, 5, 5]), baselinePlan: { maskSelectors: ['.my-ad'] } });
      ctx2.screenshotsDir = dir;
      ctx2.context = { async newPage() { return page; } };
      await visualExecutor(ctx2);
      assert.deepEqual(seenMasks, ['.my-ad']);
    });
  });
});
