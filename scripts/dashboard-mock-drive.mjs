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
// through any MCP tool (`mock.configure` is NOT_IMPLEMENTED), so cadence is fixed
// unless the run injects the dual-slot preload (see below).
//
// ── DUAL-SLOT MODE (VMCP-04.02) ────────────────────────────────────────────
// `--dual` drives TWO slots (`left` + `right`) concurrently through the same
// real tool pipeline, so dual-Voltra UI can be verified with no hardware. Stock
// `VOLTRA_ADAPTER=mock` only advertises one device, so dual mode boots the server
// with `--import scripts/mock-two-slot-preload.mjs`, which makes the mock scan
// return two devices and gives each dialled slot its OWN MockBLEAdapter (the SDK's
// LegacyAdapterHost already allocates a fresh adapter per dial). Rep isolation is
// therefore genuine: `devices[]` in `/api/snapshot` carries independent per-slot
// `sets.active`. Nothing under `src/` is patched.
//
// Asymmetry is the point — a symmetric dual run proves nothing about index-lock
// or lagging sides, so sets end on OBSERVED per-slot rep counts (polled from
// `/api/snapshot`), not on a shared wall-clock dwell:
//   --reps=left:6,right:4   per-slot target reps per set (default 5 each)
//   --lag=right:2500        that slot starts each set N ms late (aligned-empty columns)
//   --stall=right@2         freeze that slot's telemetry mid-set on set 2
//   --stall-ms=6000         stall duration; <=0 stalls for the REST OF THE RUN
//   --max-set-ms=45000      per-set poll ceiling; set.end always fires on timeout
//
// Usage:
//   npm run build && npm run build:dashboard
//   node scripts/dashboard-mock-drive.mjs                 # 1 slot, 3 sets on :7724, holds open
//   SETS=4 DWELL_MS=9000 node scripts/dashboard-mock-drive.mjs
//   HOLD=0 node scripts/dashboard-mock-drive.mjs          # exit after the workout (CI-style)
//
//   # two slots, asymmetric reps, right lagging 2.5 s, right stalls 6 s in set 2:
//   node scripts/dashboard-mock-drive.mjs --dual --sets=3 \
//     --reps=left:6,right:4 --lag=right:2500 --stall=right@2 --stall-ms=6000
//   # right side dies for good partway through set 2:
//   node scripts/dashboard-mock-drive.mjs --dual --stall=right@2 --stall-ms=0
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
const preloadPath = path.resolve(__dirname, 'mock-two-slot-preload.mjs');

// ── CLI flags (`--k=v` / `--k`), each falling back to its long-standing env var ──
const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const flag = (name, fallback) => flags.get(name) ?? fallback;

const DUAL = flags.has('dual');
const PORT = Number(flag('port', process.env.VMCP_DASHBOARD_PORT ?? 7724));
const SETS = Number(flag('sets', process.env.SETS ?? 3));
const DWELL_MS = Number(flag('dwell-ms', process.env.DWELL_MS ?? 8000)); // single-slot: reps accrue
const REST_MS = Number(flag('rest-ms', process.env.REST_MS ?? 3000));
const MAX_SET_MS = Number(flag('max-set-ms', 45000));
const STALL_MS = Number(flag('stall-ms', 6000));
const CONTROL_PORT = Number(flag('control-port', 7735));
const POLL_MS = 400;
// Default to a seeded-catalog exerciseId (not a free-text name) so the active
// session resolves to muscle groups and lights the dashboard BodyMap heatmap.
// `session.start` enforces exerciseId XOR exerciseName, so we send exactly one:
// an id when EXERCISE_ID is set (the default), else a free-text EXERCISE name.
const EXERCISE_ID = process.env.EXERCISE_ID ?? 'cable-chest-press';
const EXERCISE = process.env.EXERCISE; // free-text fallback; only used if EXERCISE_ID=''
// Keep server + dashboard alive after the workout (`--hold=0` / `HOLD=0` to exit).
const HOLD = flag('hold', process.env.HOLD ?? '1') !== '0';
// Parallel-safe DB path so this never collides with a live session's sqlite.
const DB_PATH =
  process.env.VMCP_DB_PATH ?? path.join(os.tmpdir(), `vmcp-mock-drive-${PORT}.sqlite`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[drive]', ...a);

// ── dual-slot plan ─────────────────────────────────────────────────────────
// One entry per slot. `deviceId` must match the preload's advertised devices.
const SLOTS = ['left', 'right'];
const DEVICE_ID = { left: 'mock-voltra-left', right: 'mock-voltra-right' };

/** Parse `left:6,right:4` into `{ left: 6, right: 4 }`, keeping `fallback` for absent slots. */
function parsePerSlot(spec, fallback) {
  const out = Object.fromEntries(SLOTS.map((s) => [s, fallback]));
  if (!spec || spec === 'true') return out;
  for (const pair of spec.split(',')) {
    const [slot, value] = pair.split(':');
    if (!SLOTS.includes(slot)) throw new Error(`unknown slot "${slot}" in "${spec}"`);
    out[slot] = Number(value);
  }
  return out;
}

/** Parse `right@2` into `{ left: null, right: 2 }` — the set number that slot stalls in. */
function parseStall(spec) {
  const out = Object.fromEntries(SLOTS.map((s) => [s, null]));
  if (!spec || spec === 'true') return out;
  for (const entry of spec.split(',')) {
    const [slot, setNumber] = entry.split('@');
    if (!SLOTS.includes(slot)) throw new Error(`unknown slot "${slot}" in "${spec}"`);
    out[slot] = Number(setNumber ?? 1);
  }
  return out;
}

const PLAN = {
  reps: parsePerSlot(flag('reps'), 5),
  lagMs: parsePerSlot(flag('lag'), 0),
  stallAtSet: parseStall(flag('stall')),
};

const child = spawn(process.execPath, [...(DUAL ? ['--import', preloadPath] : []), binPath], {
  env: {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(PORT),
    VMCP_DB_PATH: DB_PATH,
    VMCP_REST_TIMER: 'on',
    VMCP_MOCK_CONTROL_PORT: String(CONTROL_PORT),
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

/** Per-slot rep count as the DASHBOARD sees it: `devices[].sets.active` (VW-71). */
function slotReps(snap, slot) {
  const entry = snap.devices?.find((d) => d.slotId === slot);
  const active = entry?.sets?.active;
  if (!active) return null; // no open set on this slot right now
  return active.reps?.length ?? active.repCount ?? 0;
}

function summarizeSlots(snap, label) {
  const perSlot = SLOTS.map((s) => {
    const reps = slotReps(snap, s);
    return `${s}=${reps === null ? '—' : reps}`;
  }).join(' ');
  log(`${label} | rev=${snap.rev} reps ${perSlot}`);
}

/** Drive the preload's control plane (adapter-level stall/resume/configure). */
async function control(route, body) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${route} ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Poll `/api/snapshot` until `slot` reaches `target` reps (or the deadline).
 * Returns the last observed rep count — the caller ends the set either way,
 * because the mock never closes a set on its own.
 */
async function waitForReps(slot, target, deadline) {
  let observed = 0;
  // Always sample at least once: a slot that spent its whole window stalled
  // still has reps on the wire, and reporting 0 there would be a lie.
  do {
    const reps = slotReps(await snapshot(), slot);
    if (reps !== null) observed = reps;
    if (observed >= target) return observed;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  log(`  ${slot}: deadline hit at ${observed}/${target} reps (--max-set-ms=${MAX_SET_MS})`);
  return observed;
}

/**
 * One slot's set: optional lag before `set.start`, poll to the slot's own rep
 * target, optionally freeze telemetry partway, then ALWAYS `set.end`.
 */
async function runSlotSet(slot, setNumber) {
  const target = PLAN.reps[slot];
  if (PLAN.lagMs[slot] > 0) await sleep(PLAN.lagMs[slot]);
  await callTool('set.start', { slot });
  log(`set ${setNumber} ${slot}: started (target ${target} reps)`);
  const deadline = Date.now() + MAX_SET_MS;

  if (PLAN.stallAtSet[slot] === setNumber) {
    const before = await waitForReps(slot, Math.max(1, Math.floor(target / 2)), deadline);
    await control('/stall', { deviceId: DEVICE_ID[slot] });
    log(`set ${setNumber} ${slot}: STALLED at ${before} reps (telemetry frozen)`);
    await sleep(STALL_MS > 0 ? STALL_MS : Math.max(0, deadline - Date.now()));
    if (STALL_MS > 0) await control('/resume', { deviceId: DEVICE_ID[slot] });
    else log(`set ${setNumber} ${slot}: staying stalled for the rest of the run`);
  }

  const reps = await waitForReps(slot, target, deadline);
  await callTool('set.end', { slot });
  log(`set ${setNumber} ${slot}: ended at ${reps} reps`);
  return reps;
}

/** Bind both slots, run the asymmetric session, close both. */
async function runDual() {
  const scan = await callTool('device.scan', {});
  const ids = (scan.devices ?? []).map((d) => d.id);
  for (const slot of SLOTS) {
    if (!ids.includes(DEVICE_ID[slot])) {
      throw new Error(`scan lacks ${DEVICE_ID[slot]} — is the preload loaded? saw [${ids}]`);
    }
    await callTool('device.connect', { deviceId: DEVICE_ID[slot], slot });
    log(`slot ${slot} ← ${DEVICE_ID[slot]} (mock telemetry streaming)`);
  }
  await sleep(500);

  const sessionArgs = EXERCISE_ID
    ? { exerciseId: EXERCISE_ID }
    : { exerciseName: EXERCISE ?? 'Bench Press' };
  for (const slot of SLOTS) await callTool('session.start', { ...sessionArgs, slot });
  summarizeSlots(await snapshot(), 'sessions started');

  for (let s = 1; s <= SETS; s++) {
    const reps = await Promise.all(SLOTS.map((slot) => runSlotSet(slot, s)));
    summarizeSlots(await snapshot(), `set ${s} done   `);
    log(`set ${s}: ${SLOTS.map((slot, i) => `${slot}=${reps[i]}`).join(' ')}`);
    if (s < SETS) await sleep(REST_MS);
  }

  for (const slot of SLOTS) await callTool('session.end', { slot });
  summarizeSlots(await snapshot(), 'sessions ended ');
  log(`dual workout complete: ${SETS} sets × ${SLOTS.length} slots through the real pipeline`);
}

async function handshake() {
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
}

async function runSingle() {
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
}

async function main() {
  await handshake();
  await (DUAL ? runDual() : runSingle());

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
