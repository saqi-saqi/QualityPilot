#!/usr/bin/env node
/**
 * testigator — public CLI entry point.
 *
 * Subcommands:
 *   testigator check <url> [options]          CI quality-gate scan
 *   testigator export <plan.json>             Export plan for CI replay / Playwright specs
 *   testigator replay <plan.json>             Replay an exported plan against a target
 *   testigator merge-reports <files...>       Unify sharded JSON reports into one verdict
 *   testigator report <run.json>              Render standalone HTML or markdown report
 *
 * The MCP server ships as `testigator-mcp` (`src/mcp/stdio.js`).
 * Legacy `qualitypilot` and `qualitypilot-mcp` commands remain as aliases.
 *
 * Exit codes mirror src/cli/check.js: 0 pass, 1 gate failed, 64 usage,
 * 70 scan failure.
 */
import { pathToFileURL } from 'node:url';
import { checkMain } from './check.js';

export async function runTestigatorCli(args = process.argv.slice(2), binName = 'testigator') {
  const command = args[0];

  if (command === 'check') {
    return checkMain([binName, 'check', ...args.slice(1)]);
  }
  if (command === 'export') {
    const { exportMain } = await import('./export.js');
    return exportMain([binName, 'export', ...args.slice(1)]);
  }
  if (command === 'replay') {
    const { replayMain } = await import('./replay.js');
    return replayMain([binName, 'replay', ...args.slice(1)]);
  }
  if (command === 'report') {
    const { reportMain } = await import('./report.js');
    return reportMain([binName, 'report', ...args.slice(1)]);
  }
  if (command === 'merge-reports') {
    const { mergeReportsMain } = await import('./mergeReports.js');
    return mergeReportsMain([binName, 'merge-reports', ...args.slice(1)]);
  }

  console.error(`Usage: ${binName} <command> [options]`);
  console.error('');
  console.error('Commands:');
  console.error('  check <url> [options]      CI quality-gate scan');
  console.error('  export <plan.json>         export a plan for CI replay or standalone Playwright');
  console.error('                             [--format plan|specs|both] [--out <dir>]');
  console.error('                             [--storage-state <role>=<path>]');
  console.error('  replay <plan.json>         replay an exported plan against a target (--url)');
  console.error('                             with the full matrix + classifiers, no LLM needed');
  console.error('                             [--shard <i/N>] [--shard-out <file>]');
  console.error('  merge-reports <files...>   unify sharded JSON reports into one verdict + exports');
  console.error('  report <run.json>          turn a saved run into a shareable HTML/markdown report');
  console.error('                             [--html <out.html>] [--markdown <out.md>] [--ignore-file <f>]');
  console.error('');
  console.error('Check options:');
  console.error('  --fail-on <sev|list>   single severity = threshold ("at or above");');
  console.error('                         comma list = confirmed findings at those severities');
  console.error('  --min-score <n>        fail when the score is below n (0-100)');
  console.error('  --max-pages <n>        max pages to crawl (default 10)');
  console.error('  --max-depth <n>        max crawl depth (default 1)');
  console.error('  --timeout <ms>         run timeout (default 120000)');
  console.error('  --shard <i/N>          run shard i of N with isolated SQLite/artifact storage');
  console.error('  --shard-out <file>     write portable shard JSON artifact');
  console.error('  --llm-preset <name>    ollama | vllm | openrouter | openai | byo');
  console.error('  --junit <file>         write a JUnit XML report');
  console.error('  --sarif <file>         write a SARIF 2.1.0 report');
  console.error('  --format <fmt>         stdout format: json | junit | sarif | markdown');
  console.error('  --strict               fail on report invariant violations');
  console.error('');
  console.error('The MCP server is the separate `testigator-mcp` command.');
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTestigatorCli(process.argv.slice(2), 'testigator');
}
