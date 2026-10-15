#!/usr/bin/env node
// Loud bench pre-flight: one line per silent-failure gate, before the lifter
// is under load. Called by scripts/voltra-pt; safe to run on its own.
//
// Exits 1 only for whisper-cli, Node and a store newer than the build — the
// gates that make the session worthless rather than merely degraded.
// Everything else prints WARN and the launch continues.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DASHBOARD_PORT,
  evaluateGates,
  exitCodeFor,
  parseLsofListeners,
  readSqliteUserVersion,
} from './lib/preflight-gates.mjs';
import { whisperArtifactPaths } from './lib/whisper-paths.mjs';

const LEVEL_LABEL = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

function probeWhisper() {
  try {
    const packageRoot = dirname(
      createRequire(import.meta.url).resolve('nodejs-whisper/package.json'),
    );
    const { cli, model } = whisperArtifactPaths(packageRoot);
    return { whisperCliPresent: existsSync(cli), whisperModelPresent: existsSync(model) };
  } catch {
    return { whisperCliPresent: false, whisperModelPresent: false };
  }
}

function probePortListeners() {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${DASHBOARD_PORT}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (lsof.error !== undefined || typeof lsof.stdout !== 'string') return [];
  return parseLsofListeners(lsof.stdout);
}

// The build that launches is dist/, so that is where its schema version is read.
async function probeBuildSchemaVersion() {
  try {
    const built = join(dirname(import.meta.dirname), 'dist', 'store', 'sqlite-store.js');
    const { SCHEMA_VERSION } = await import(pathToFileURL(built).href);
    return Number.isInteger(SCHEMA_VERSION) ? SCHEMA_VERSION : null;
  } catch {
    return null;
  }
}

const storePath = process.env.VMCP_DB_PATH ?? join(homedir(), '.voltras', 'vmcp.sqlite');

const gates = evaluateGates({
  ...probeWhisper(),
  buildSchemaVersion: await probeBuildSchemaVersion(),
  storePath,
  storeSchemaVersion: readSqliteUserVersion(storePath),
  env: process.env,
  nodeVersion: process.version,
  portListeners: probePortListeners(),
  selfPid: process.pid,
});

process.stderr.write('voltra-pt pre-flight:\n');
for (const gate of gates) {
  process.stderr.write(`  ${LEVEL_LABEL[gate.level]}  ${gate.id}: ${gate.message}\n`);
}

const code = exitCodeFor(gates);
if (code !== 0) {
  process.stderr.write('\nPre-flight FAILED. Fix the FAIL lines above before lifting.\n');
}
process.exit(code);
