#!/usr/bin/env node
// truecoach-submit — post one voltras-mcp session's results into that day's
// TrueCoach workout.
//
// GATE 1: Xplor's terms of service, section A.4(d), forbid third-party
// applications interacting with the service without written consent. This job
// is the human's accepted risk on their own client account, and the coach
// should be told before the first real submit.
//
// GATE 2: any DOM selector change fails closed. If one expected element is
// missing, nothing is filled and nothing is submitted; there are no partial
// posts.
//
// Default is a DRY RUN: fill the boxes, take a screenshot, submit nothing.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULT_STALE_HOURS } from './freshness.js';
import { notifyHuman } from './notify.js';
import { resolvePaths } from './paths.js';
import { runLogin } from './browser.js';
import { runAll } from './run.js';

const USAGE = `truecoach-submit [--submit] [--session <id> | --all] [--stale-hours N]
truecoach-submit login

Default: dry run over every pending outbox entry. --submit is the only flag
that clicks anything. Stale window defaults to ${DEFAULT_STALE_HOURS}h.`;

export function parseArgs(argv) {
  const options = { submit: false, session: undefined, staleHours: undefined, command: 'run' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'login') options.command = 'login';
    else if (arg === '--submit') options.submit = true;
    else if (arg === '--all') options.session = undefined;
    else if (arg === '--headed') options.headless = false;
    else if (arg === '--session') options.session = requireValue(argv, (i += 1), '--session');
    else if (arg === '--stale-hours') {
      options.staleHours = Number(requireValue(argv, (i += 1), '--stale-hours'));
      if (!Number.isFinite(options.staleHours)) throw new Error('--stale-hours needs a number');
    } else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`unknown argument "${arg}"\n\n${USAGE}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function report(results, submit) {
  console.error(submit ? 'truecoach-submit: SUBMIT run' : 'truecoach-submit: dry run (no submit)');
  for (const result of results) {
    console.error(
      `  ${result.code.padEnd(20)} ${result.sessionId}  ${result.detail ?? ''}`.trimEnd(),
    );
    if (result.screenshot !== undefined) console.error(`  ${' '.repeat(20)} ${result.screenshot}`);
  }
  if (results.length === 0) console.error('  nothing pending');
}

/** `overrides` is the test seam for the browser launcher; the CLI never sets it. */
export async function main(argv, paths = resolvePaths(), overrides = {}) {
  const options = { ...parseArgs(argv), ...overrides };
  if (options.command === 'help') {
    console.error(USAGE);
    return 0;
  }
  if (options.command === 'login') {
    await runLogin(paths);
    return 0;
  }
  const { results, exitCode } = await runAll(paths, options);
  report(results, options.submit);
  const blocked = results.find((result) => result.code === 'login_required');
  if (blocked === undefined) return exitCode;
  notifyHuman(`TrueCoach wants a login; session ${blocked.sessionId} was not posted.`);
  return 2;
}

/** True when run as the `truecoach-submit` bin, false when imported by a test. */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`truecoach-submit: ${err.message ?? String(err)}`);
      process.exit(1);
    },
  );
}
