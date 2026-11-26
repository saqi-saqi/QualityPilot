#!/usr/bin/env node
/**
 * qualitypilot — backward-compatible CLI alias delegating to `testigator`.
 */
import { pathToFileURL } from 'node:url';
import { runTestigatorCli } from './testigator.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTestigatorCli(process.argv.slice(2), 'testigator');
}
