#!/usr/bin/env node
// dashboard-mock-drive: REAL-pipeline no-hardware run→feed→observe loop.
//
// Unlike `dashboard-sim.mjs` (which mutates a fake `DashboardServerState` object
// and bypasses the SDK, event-bridge, and LiveState), this driver boots the
// ACTUAL MCP server (`dist/bin.js`) with `VOLTRA_ADAPTER=mock` and drives a
// workout through the REAL voltras MCP tools over stdio JSON-RPC:
//
//   device.scan → device.connect → session.start → (set.start → set.end)×N → session.end
//
// In mock mode `VoltraManager.forMock()` gives an in-process MockBLEAdapter that
// streams real telemetry frames (~11 Hz) the moment `device.connect` runs. Those
// frames flow through the SAME path a real device uses — event-bridge →
// LiveState.processSample (canonical rep detection) → dashboard `/api/snapshot`
// poll + `/api/stream` SSE. `set.start`/`set.end` partition the continuous rep
// stream into MCP sets and each boundary emits the `{type:'set'}` live-signal,
// which the server turns into an SSE `snapshot` push (rev-guarded). This is the
// real reconciliation pipeline VMCP-03.04 shipped — validated here without
// hardware.
//
// The mock never emits an `aa 85 5f` set-summary frame, so a set NEVER
// auto-closes: `set.end` MUST be called explicitly (it is, below). Reps accrue
// continuously into whatever MCP set is open, at the mock's default cadence
// (~5 reps/cycle, 100 lb, WeightTraining) — the adapter config is not reachable
// through any MCP tool, so cadence is fixed unless you bypass `selectAdapter`.
//
// Usage:
//   npm run build && npm run build:dashboard
//   node scripts/dashboard-mock-drive.mjs                 # 3 sets on :7724, holds open
//   SETS=4 DWELL_MS=9000 node scripts/dashboard-mock-drive.mjs
//   HOLD=0 node scripts/dashboard-mock-drive.mjs          # exit after the workout (CI-style)
//
// Then open http://127.0.0.1:7724/app in a browser BEFORE/DURING the run — the
// set-log accumulates client-side across polls, so a late-joining page misses
// the non-null→null set transitions it logs.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../dist/bin.js');

const PORT = Number(process.env.VMCP_DASHBOARD_PORT ?? 7724);
const SETS = Number(process.env.SETS ?? 3);
const DWELL_MS = Number(process.env.DWELL_MS ?? 8000); // let reps accrue per set
const REST_MS = Number(process.env.REST_MS ?? 3000);
// Default to a seeded-catalog exerciseId (not a free-text name) so the active
// session resolves to muscle groups and lights the dashboard BodyMap heatmap.
// `session.start` enforces exerciseId XOR exerciseName, so we send exactly one:
// an id when EXERCISE_ID is set (the default), else a free-text EXERCISE name.
const EXERCISE_ID = process.env.EXERCISE_ID ?? 'cable-chest-press';
const EXERCISE = process.env.EXERCISE; // free-text fallback; only used if EXERCISE_ID=''
const HOLD = process.env.HOLD !== '0'; // keep server + dashboard alive after the workout
// Parallel-safe DB path so this never collides with a live session's sqlite.
const DB_PATH =
  process.env.VMCP_DB_PATH ?? path.join(os.tmpdir(), `vmcp-mock-drive-${PORT}.sqlite`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[drive]', ...a);

const child = spawn(process.execPath, [binPath], {
  env: {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(PORT),
    VMCP_DB_PATH: DB_PATH,
    VMCP_REST_TIMER: 'on',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// ── stdio JSON-RPC plumbing (same shape as scripts/smoke-test.mjs) ──────────
let stdoutBuffer = '';
const responses = new Map();
let nextId = 1;

function sendRequest(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15000);
    responses.set(id, { resolve, reject, timeout });
  });
}

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && responses.has(msg.id)) {
        const { resolve, timeout } = responses.get(msg.id);
        clearTimeout(timeout);
        responses.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // non-JSON-RPC line (log noise) — ignore
    }
  }
});

let stderrBuffer = '';
child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});
child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[drive] mcp exited code ${code}`);
    if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
    process.exit(1);
  }
});

// Unwrap a tools/call response into its structured payload; throw on tool error.
async function callTool(name, args = {}) {
  const resp = await sendRequest('tools/call', { name, arguments: args });
  if (resp.error) throw new Error(`${name} JSON-RPC error: ${JSON.stringify(resp.error)}`);
  const result = resp.result;
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join(' ') ?? '';
    throw new Error(`${name} tool error: ${text}`);
  }
  // Prefer structuredContent; fall back to the first text block parsed as JSON.
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  try {
    return text ? JSON.parse(text) : result;
  } catch {
    return text ?? result;
  }
}

// Poll the dashboard's reconciliation endpoint (the ~2 s poll the SPA runs).
async function snapshot() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`);
  if (!res.ok) throw new Error(`/api/snapshot ${res.status}`);
  return res.json();
}

function summarize(snap, label) {
  const set = snap.sets?.active;
  const session = snap.session;
  log(
    `${label} | rev=${snap.rev} session=${session ? (session.exerciseName ?? session.exerciseId ?? 'active') : 'none'} ` +
      `activeSet=${set ? `#${set.setNumber ?? '?'} reps=${set.reps?.length ?? set.repCount ?? 0}` : 'none'}`,
  );
}

async function main() {
  // MCP handshake
  const init = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dashboard-mock-drive', version: '0.1.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  log('MCP initialized; waiting for handlers + dashboard bind…');
  await sleep(2000); // bootstrap swaps placeholders for real handlers + binds dashboard

  // Sanity: confirm the real device.scan handler is present (not a placeholder)
  const tools = (await sendRequest('tools/list', {})).result.tools.map((t) => t.name);
  for (const need of ['device.scan', 'device.connect', 'session.start', 'set.start', 'set.end']) {
    if (!tools.includes(need)) throw new Error(`missing tool ${need}`);
  }
  log(`dashboard at http://127.0.0.1:${PORT}/app  (open it now)`);

  // 1. scan → find the mock device
  const scan = await callTool('device.scan', {});
  const devId = scan.devices?.[0]?.id;
  if (!devId) throw new Error('scan returned no device');
  log(`scanned: ${devId} (${scan.devices[0].name})`);

  // 2. connect → mock telemetry starts streaming immediately
  await callTool('device.connect', { deviceId: devId });
  log('connected — mock telemetry streaming');
  await sleep(500);

  // 3. session — send exerciseId (catalog-resolved → lights BodyMap) or a name.
  const sessionArgs = EXERCISE_ID
    ? { exerciseId: EXERCISE_ID }
    : { exerciseName: EXERCISE ?? 'Bench Press' };
  await callTool('session.start', sessionArgs);
  summarize(await snapshot(), 'session.start');

  // 4. set.start → dwell (reps accrue) → set.end, repeated
  for (let s = 1; s <= SETS; s++) {
    await callTool('set.start', {});
    await sleep(300);
    summarize(await snapshot(), `set ${s} start  `); // rev should bump vs prior (SSE snapshot push)
    await sleep(DWELL_MS);
    summarize(await snapshot(), `set ${s} mid    `); // reps accrued from mock frames
    await callTool('set.end', {});
    summarize(await snapshot(), `set ${s} end    `); // set finalized; rev bumps again
    if (s < SETS) await sleep(REST_MS);
  }

  // 5. close session
  await callTool('session.end', {});
  summarize(await snapshot(), 'session.end');
  log(`workout complete: ${SETS} sets driven through the real pipeline`);

  if (HOLD) {
    log('HOLD=1 — server + dashboard staying up. Ctrl-C to exit.');
  } else {
    child.kill();
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  child.kill();
  process.exit(0);
});

main().catch((err) => {
  console.error('[drive] FAIL:', err.message);
  if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
  child.kill();
  process.exit(1);
});
