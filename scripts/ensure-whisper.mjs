#!/usr/bin/env node
// Rebuild the whisper.cpp CLI that `npm ci` silently discards (VW-155).
//
// `nodejs-whisper` ships C++ sources, not a binary. It builds them the first
// time it transcribes, so a fresh `npm ci` restores the package and leaves
// voice input dead with no error until someone speaks at the bench. Run from
// `postinstall` and again from scripts/voltra-pt, so the rebuild happens at
// install time and, failing that, before a session rather than during one.
//
// Never exits non-zero: a missing toolchain must not break `npm ci`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { decideWhisperAction, whisperArtifactPaths } from './lib/whisper-paths.mjs';

const LOG_PREFIX = '[ensure-whisper]';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function resolvePackageRoot() {
  try {
    return dirname(createRequire(import.meta.url).resolve('nodejs-whisper/package.json'));
  } catch {
    return null;
  }
}

function hasCmake() {
  const probe = spawnSync('cmake', ['--version'], { stdio: 'ignore' });
  return probe.error === undefined && probe.status === 0;
}

function build(packageRoot) {
  const run = (args) =>
    spawnSync('cmake', args, { cwd: packageRoot + '/cpp/whisper.cpp', stdio: 'inherit' });
  const configured = run(['-B', 'build']);
  if (configured.status !== 0) return false;
  return run(['--build', 'build', '--config', 'Release']).status === 0;
}

function main() {
  const packageRoot = resolvePackageRoot();
  if (packageRoot === null) {
    log('SKIP: nodejs-whisper is not installed.');
    return;
  }

  const { cli } = whisperArtifactPaths(packageRoot);
  const decision = decideWhisperAction({
    cliPresent: existsSync(cli),
    cmakePresent: hasCmake(),
    env: process.env,
  });

  if (decision.action === 'present') {
    log(`OK: whisper-cli present at ${cli}`);
    return;
  }
  if (decision.action === 'skip') {
    log(`SKIP: ${decision.reason} — voice input will not work until whisper-cli is built.`);
    return;
  }

  log(
    `BUILD: ${decision.reason} — running cmake in ${packageRoot}/cpp/whisper.cpp (a few minutes).`,
  );
  if (build(packageRoot) && existsSync(cli)) {
    log(`OK: rebuilt whisper-cli at ${cli}`);
  } else {
    log('FAILED: cmake build did not produce whisper-cli. Voice input will not work.');
  }
}

main();
