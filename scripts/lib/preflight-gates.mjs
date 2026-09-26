// Pure gate evaluation for the bench pre-flight (scripts/preflight.mjs).
//
// Every gate here guards a configuration mistake that fails SILENTLY at the
// bench: the rest of the system keeps working and the missing capability just
// never produces an event. That shape cost most of the 2026-08-11 sitting and
// showed up again on 2026-09-07, so the check runs before the lifter is under
// load rather than after. See sources/runbooks/BENCH-2026-07-26-consolidated.md
// Phase 0.
//
// Split pure/impure on purpose: this module turns a snapshot of the world into
// a list of findings, and the caller does the probing and the printing.

import { closeSync, openSync, readSync } from 'node:fs';

/** Dashboard sidecar default port (src/dashboard/server.ts DEFAULT_DASHBOARD_PORT). */
export const DASHBOARD_PORT = 7723;

/** Minimum Node the server supports (package.json `engines.node`). */
export const MIN_NODE = { major: 22, minor: 5 };

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` output into listener rows. */
export function parseLsofListeners(stdout) {
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && /^\d+$/.test(cols[1]))
    .map((cols) => ({ command: cols[0], pid: Number(cols[1]) }));
}

/** True when `version` (e.g. `v22.4.1`) is older than the supported minimum. */
export function isNodeTooOld(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major !== MIN_NODE.major) return major < MIN_NODE.major;
  return minor < MIN_NODE.minor;
}

const SQLITE_MAGIC = 'SQLite format 3\0';
const USER_VERSION_OFFSET = 60;
const SQLITE_HEADER_BYTES = 100;

/**
 * Read PRAGMA user_version straight from the file header, so the live store is
 * never opened (opening runs migrations). Null when the file is absent or is
 * not a sqlite database.
 */
export function readSqliteUserVersion(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const read = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
    if (read < SQLITE_HEADER_BYTES) return null;
    if (header.toString('latin1', 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) return null;
    return header.readUInt32BE(USER_VERSION_OFFSET);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function schemaGate({ buildSchemaVersion, storeSchemaVersion, storePath }) {
  if (buildSchemaVersion === null || buildSchemaVersion === undefined) {
    return {
      id: 'schema',
      level: 'warn',
      message: 'Cannot read the build schema version (dist/ is missing); run `npm run build`.',
    };
  }
  if (storeSchemaVersion === null || storeSchemaVersion === undefined) {
    return {
      id: 'schema',
      level: 'ok',
      message: `No store at ${storePath}; the build creates one at v${buildSchemaVersion}.`,
    };
  }
  if (storeSchemaVersion > buildSchemaVersion) {
    return {
      id: 'schema',
      level: 'fail',
      message: `Store ${storePath} is at schema v${storeSchemaVersion}, newer than this build's v${buildSchemaVersion}. This build refuses to open it (the 2026-09-13 lost sitting). Rebuild from a newer checkout.`,
    };
  }
  if (storeSchemaVersion < buildSchemaVersion) {
    return {
      id: 'schema',
      level: 'warn',
      message: `Store ${storePath} is at schema v${storeSchemaVersion}; this build will migrate it forward to v${buildSchemaVersion} on open. Back the file up first.`,
    };
  }
  return {
    id: 'schema',
    level: 'ok',
    message: `Store schema v${storeSchemaVersion} matches the build.`,
  };
}

function whisperGate({ whisperCliPresent, whisperModelPresent }) {
  if (!whisperCliPresent) {
    return {
      id: 'whisper',
      level: 'fail',
      message:
        'whisper-cli is missing — voice input will not transcribe. ' +
        'Run `node scripts/ensure-whisper.mjs` (needs cmake).',
    };
  }
  if (!whisperModelPresent) {
    return {
      id: 'whisper',
      level: 'warn',
      message: 'whisper-cli is built but the tiny.en model is missing; it downloads on first use.',
    };
  }
  return { id: 'whisper', level: 'ok', message: 'whisper-cli and tiny.en model present.' };
}

function nodeGate({ nodeVersion }) {
  if (isNodeTooOld(nodeVersion)) {
    return {
      id: 'node',
      level: 'fail',
      message: `Node ${nodeVersion} is below the required v${MIN_NODE.major}.${MIN_NODE.minor} (node:sqlite).`,
    };
  }
  return { id: 'node', level: 'ok', message: `Node ${nodeVersion}.` };
}

function pushChannelGate({ env }) {
  if (env.VOLTRA_PT_DEV === '1') {
    return {
      id: 'push-channel',
      level: 'warn',
      message:
        'VOLTRA_PT_DEV=1 selects --dangerously-load-development-channels, which needs an ' +
        'approval dialog and so registers NOTHING in a scripted session. Push events will ' +
        'degrade to polling (VW-158). Unset it to use plugin mode.',
    };
  }
  return { id: 'push-channel', level: 'ok', message: 'Plugin mode — push channel registers.' };
}

function cueGate({ env }) {
  const cues = env.VMCP_CUES ?? 'off';
  const midSet = env.VMCP_CUES_MIDSET ?? 'off';
  const effective = `VMCP_CUES=${cues} VMCP_CUES_MIDSET=${midSet}`;
  if (env.VMCP_CUES === undefined) {
    return {
      id: 'cues',
      level: 'warn',
      message: `VMCP_CUES is unset, so nothing will speak. Effective: ${effective}. Mid-set cues (target_hit / slowdown) additionally need VMCP_CUES_MIDSET=on.`,
    };
  }
  return { id: 'cues', level: 'ok', message: `Effective: ${effective}.` };
}

function dashboardPortGate({ portListeners, selfPid }) {
  const others = portListeners.filter((row) => row.pid !== selfPid);
  if (others.length > 0) {
    const who = others.map((row) => `${row.command}(${row.pid})`).join(', ');
    return {
      id: 'dashboard-port',
      level: 'warn',
      message: `Port ${DASHBOARD_PORT} is already held by ${who}. Every session spawns its own server and the first one wins the port, so this session falls back to an OS-assigned port (VW-167) — read the real URL from \`server.health\` (\`dashboardUrl\`), not from memory.`,
    };
  }
  return { id: 'dashboard-port', level: 'ok', message: `Port ${DASHBOARD_PORT} is free.` };
}

/**
 * Evaluate every bench gate over a snapshot of env + filesystem + process
 * state. Order is the order they print in.
 */
export function evaluateGates(snapshot) {
  const filled = { env: {}, portListeners: [], selfPid: 0, ...snapshot };
  return [
    whisperGate(filled),
    nodeGate(filled),
    pushChannelGate(filled),
    cueGate(filled),
    dashboardPortGate(filled),
    schemaGate(filled),
  ];
}

/** Only whisper, Node, and a store newer than the build are hard blockers; everything else is advisory. */
export function exitCodeFor(gates) {
  return gates.some((gate) => gate.level === 'fail') ? 1 : 0;
}
