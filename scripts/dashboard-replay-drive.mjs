#!/usr/bin/env node
// dashboard-replay-drive: the 5th rung of the driver ladder (VW-256) — play a
// flight-recorder capture through the REAL pipeline and dashboard.
//
// Every other driver in `docs/dashboard-drivers.md` either fabricates
// telemetry (`dashboard-sim.mjs`) or synthesizes it live (`dashboard-mock-drive.mjs`,
// `dashboard-plan-drive.mjs`). This one replays a capture recorded off a REAL
// Voltra (`VMCP_RECORD_SESSION=1`, see `src/state/session-recorder.ts`) —
// the closest a no-hardware run gets to a real bench session.
//
// It boots the real MCP server (`dist/bin.js`) with `VOLTRA_ADAPTER=mock`
// and `--import scripts/replay-preload.mjs`, which swaps the mock manager's
// adapter for the SDK's `ReplayBLEAdapter` fed by `loadCaptureFrames`
// (`@voltras/node-sdk/testing`) — the exact pair the capture's
// `{ type: 'frame_in', ts, hex }` schema was designed for, with no shim in
// between. From there the tool sequence is the same real pipeline as
// `dashboard-mock-drive.mjs`: device.scan -> device.connect -> session.start
// -> set.start -> ... -> set.end -> session.end.
//
// ── Why playback starts on `/play`, not on connect ─────────────────────────
// `ReplayBLEAdapter` autostarts on connect by default — but voltras-mcp only
// accumulates reps into a set that is already OPEN (`LiveState.processSample`
// no-ops otherwise), and opening that set costs a `set.start` round-trip. If
// playback started on connect, most or all of a short capture could stream
// and be dropped before `set.start` ever ran. The preload disables autostart
// and exposes a loopback control server instead; this driver calls `/play`
// immediately after `set.start` succeeds, then polls `/status` until the
// capture has drained.
//
// ── What this driver does NOT do ────────────────────────────────────────
// A capture holds raw telemetry only (`loadCaptureFrames` keeps `frame_in`
// lines classified `telemetry_stream` and drops everything else) — any
// device-sent set-boundary frame in the original session is filtered out
// before replay ever sees it. So this driver treats the WHOLE capture as ONE
// set, exactly as recorded reps accrue into whatever set is open; slicing a
// multi-set bench session into separate dashboard sets would need capture
// metadata this format does not carry, and is not something this rung claims.
//
// Usage:
//   npm run build
//   node scripts/dashboard-replay-drive.mjs --capture=~/.voltras/captures/voltra-capture-....jsonl
//   node scripts/dashboard-replay-drive.mjs --capture=/path/to.jsonl --speed=4
//   HOLD=0 node scripts/dashboard-replay-drive.mjs --capture=/path/to.jsonl   # exit after the replay
//
// Open http://127.0.0.1:7727/app BEFORE/DURING the run to watch reps land.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../dist/bin.js');
const preloadPath = path.resolve(__dirname, 'replay-preload.mjs');

const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const flag = (name, fallback) => flags.get(name) ?? fallback;

const rawCapture = flag('capture', process.env.VMCP_REPLAY_CAPTURE);
if (!rawCapture) {
  console.error(
    '[drive] --capture=<path> is required (a JSONL capture from VMCP_RECORD_SESSION=1, ' +
      `default dir ${path.join(homedir(), '.voltras', 'captures')})`,
  );
  process.exit(1);
}
const CAPTURE_PATH = path.resolve(rawCapture.replace(/^~(?=\/|$)/, homedir()));
if (!existsSync(CAPTURE_PATH)) {
  console.error(`[drive] capture file not found: ${CAPTURE_PATH}`);
  process.exit(1);
}

const PORT = Number(flag('port', process.env.VMCP_DASHBOARD_PORT ?? 7727));
const CONTROL_PORT = Number(flag('control-port', 7736));
const SPEED = Number(flag('speed', process.env.VMCP_REPLAY_SPEED ?? 1));
const EXERCISE_ID = process.env.EXERCISE_ID ?? 'cable-chest-press';
const EXERCISE = process.env.EXERCISE;
const HOLD = flag('hold', process.env.HOLD ?? '1') !== '0';
/** How long the replay is given to drain before the driver gives up waiting. */
const DRAIN_TIMEOUT_MS = Number(flag('drain-timeout-ms', 120_000));
const POLL_MS = 250;
const DB_PATH =
  process.env.VMCP_DB_PATH ?? path.join(os.tmpdir(), `vmcp-replay-drive-${PORT}.sqlite`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[drive]', ...a);

const child = spawn(process.execPath, ['--import', preloadPath, binPath], {
  env: {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(PORT),
    VMCP_DB_PATH: DB_PATH,
    VMCP_REST_TIMER: 'on',
    VMCP_REPLAY_CAPTURE: CAPTURE_PATH,
    VMCP_REPLAY_SPEED: String(SPEED),
    VMCP_REPLAY_CONTROL_PORT: String(CONTROL_PORT),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// ── stdio JSON-RPC plumbing (same shape as scripts/dashboard-mock-drive.mjs) ──
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

async function callTool(name, args = {}) {
  const resp = await sendRequest('tools/call', { name, arguments: args });
  if (resp.error) throw new Error(`${name} JSON-RPC error: ${JSON.stringify(resp.error)}`);
  const result = resp.result;
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join(' ') ?? '';
    throw new Error(`${name} tool error: ${text}`);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  try {
    return text ? JSON.parse(text) : result;
  } catch {
    return text ?? result;
  }
}

async function snapshot() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`);
  if (!res.ok) throw new Error(`/api/snapshot ${res.status}`);
  return res.json();
}

async function replayStatus() {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/status`);
  if (!res.ok) throw new Error(`replay-preload /status ${res.status}`);
  return res.json();
}

function summarize(snap, label) {
  const set = snap.sets?.active;
  log(
    `${label} | rev=${snap.rev} activeSet=${set ? `reps=${set.reps?.length ?? set.repCount ?? 0}` : 'none'}`,
  );
}

/** Trigger playback and poll until the adapter reports every frame delivered. */
async function playAndWaitForDrain() {
  const started = await fetch(`http://127.0.0.1:${CONTROL_PORT}/play`, { method: 'POST' });
  if (!started.ok) throw new Error(`replay-preload /play ${started.status}`);
  log('replay started');

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const status = await replayStatus();
    if (!status.playing && status.currentFrameIndex + 1 >= status.totalFrames) {
      log(`replay drained: ${status.currentFrameIndex + 1}/${status.totalFrames} frames`);
      return;
    }
    if (Date.now() >= deadline) {
      log(
        `drain timeout at ${status.currentFrameIndex + 1}/${status.totalFrames} frames ` +
          `(--drain-timeout-ms=${DRAIN_TIMEOUT_MS})`,
      );
      return;
    }
    await sleep(POLL_MS);
  }
}

async function handshake() {
  const init = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dashboard-replay-drive', version: '0.1.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  log('MCP initialized; waiting for handlers + dashboard bind…');
  await sleep(2000);

  const tools = (await sendRequest('tools/list', {})).result.tools.map((t) => t.name);
  for (const need of ['device.scan', 'device.connect', 'session.start', 'set.start', 'set.end']) {
    if (!tools.includes(need)) throw new Error(`missing tool ${need}`);
  }
  log(`dashboard at http://127.0.0.1:${PORT}/app  (open it now)`);
}

async function run() {
  const scan = await callTool('device.scan', {});
  const devId = scan.devices?.[0]?.id;
  if (!devId) throw new Error('scan returned no device');
  log(`scanned: ${devId} (${scan.devices[0].name})`);

  await callTool('device.connect', { deviceId: devId });
  log('connected — replay armed, not yet playing');
  await sleep(500);

  const sessionArgs = EXERCISE_ID
    ? { exerciseId: EXERCISE_ID }
    : { exerciseName: EXERCISE ?? 'Bench Press' };
  await callTool('session.start', sessionArgs);
  summarize(await snapshot(), 'session.start');

  await callTool('set.start', {});
  summarize(await snapshot(), 'set.start  ');

  await playAndWaitForDrain();
  summarize(await snapshot(), 'replay done');

  await callTool('set.end', {});
  summarize(await snapshot(), 'set.end    ');

  await callTool('session.end', {});
  summarize(await snapshot(), 'session.end');
  log('replay complete: capture driven through the real pipeline as one set');
}

async function main() {
  await handshake();
  await run();

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
