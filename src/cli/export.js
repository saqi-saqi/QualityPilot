/**
 * src/cli/export.js — export a Testigator plan for CI replay or standalone Playwright.
 *
 * Usage:
 *   testigator export <plan.json> [--format plan|specs|both] [--out <dir>]
 *                     [--storage-state <role>=<path>]...
 *
 *   --format plan   → <out>/plan.json (portable artifact for CI plan replay)
 *   --format specs  → <out>/<flow>.spec.ts + testigator-healer.ts
 *   --format both   → both of the above (default)
 *   --storage-state role=path → group flows into per-role describes with
 *                     `test.use({ storageState })` (multi-role export)
 *
 * Exit codes: 0 ok, 64 usage, 70 export failure.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { exportPlanJson } from '../export/planJson.js';
import { exportPlaywrightSpecs } from '../export/playwright.js';

const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_FAILURE = 70;

const FORMATS = ['plan', 'specs', 'both'];

function parseExportArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const opts = { format: 'both', outDir: null, storageStateByRole: {}, planFile: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format') {
      opts.format = String(args[++i] || '').toLowerCase();
      if (!FORMATS.includes(opts.format)) {
        throw new Error(`Invalid --format value: ${opts.format}. Must be one of: ${FORMATS.join(', ')}`);
      }
    } else if (a === '--out') {
      opts.outDir = args[++i];
      if (!opts.outDir) throw new Error('--out requires a directory path');
    } else if (a === '--storage-state') {
      const pair = String(args[++i] || '');
      const eq = pair.indexOf('=');
      if (eq <= 0) throw new Error('--storage-state expects <role>=<path>');
      opts.storageStateByRole[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (a === '--help' || a === '-h') {
      throw new Error('Usage: testigator export <plan.json> [--format plan|specs|both] [--out <dir>] [--storage-state <role>=<path>]...');
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    throw new Error('Usage: testigator export <plan.json> [--format plan|specs|both] [--out <dir>] [--storage-state <role>=<path>]...');
  }
  opts.planFile = positional[0];
  return opts;
}

export async function exportMain(argv = process.argv) {
  let opts;
  try {
    opts = parseExportArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }

  try {
    const raw = JSON.parse(await readFile(opts.planFile, 'utf8'));
    const artifact = exportPlanJson(raw, { source: opts.planFile });
    const outDir = opts.outDir || path.join(process.cwd(), 'testigator-export');
    await mkdir(outDir, { recursive: true });

    if (opts.format === 'plan' || opts.format === 'both') {
      const planPath = path.join(outDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
      console.log(`Wrote ${planPath}`);
    }

    if (opts.format === 'specs' || opts.format === 'both') {
      const { files, notes } = exportPlaywrightSpecs(artifact.plan, {
        source: opts.planFile,
        storageStateByRole: Object.keys(opts.storageStateByRole).length > 0 ? opts.storageStateByRole : undefined,
      });
      for (const f of files) {
        const p = path.join(outDir, f.name);
        await writeFile(p, f.content, 'utf8');
        console.log(`Wrote ${p}`);
      }
      for (const n of notes) console.log(`note: ${n}`);
    }

    return EXIT_OK;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_FAILURE;
  }
}

// ─── direct CLI entry (same pattern as check.js) ─────────────────────
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  exportMain(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err);
      process.exitCode = EXIT_FAILURE;
    });
}
