#!/usr/bin/env node
// export-agent-transcript: play an authored exchange against the real MCP server
// on the mock adapter and write the redacted transcript a video agent pane
// renders (VW-257, slice S2). See docs/agent-transcript.md.
//
// The server is `dist/bin.js` with `VOLTRA_ADAPTER=mock`, booted with an env
// built from scratch: HOME, the store, the slot bindings and the capture dir all
// point into a temp dir, so no real store and nothing under the user's home is
// ever opened. The dashboard, auto-arm, rest timer and cues are off.
//
// Every value that reaches the file passes the fail-closed gates in
// `src/docs/agent-transcript.ts` (imported from `dist/docs/`). Raw responses
// and pushes live in memory only. Any refusal exits 1 and writes nothing.
//
// Rep pushes are pinned (scripts/lib/mock-burst.mjs): the mock device parks
// after connect, and each `set.start` releases one burst of exactly
// `pinnedReps` reps, so two exports of one exchange are byte-identical.
//
// Usage:
//   npm run build
//   node scripts/export-agent-transcript.mjs --exchange <exchange.json> --out <transcript.json>

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  armBursts,
  burstDurationMs,
  pinnedConnectProfile,
  releaseBurst,
} from './lib/mock-burst.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');
const TRANSCRIPT_MODULE = path.join(REPO_ROOT, 'dist/docs/agent-transcript.js');
const PRELOADS = ['mock-settings-echo-preload.mjs', 'mock-two-slot-preload.mjs'].map((file) =>
  path.join(REPO_ROOT, 'scripts', file),
);
const MOCK_DEVICE = { deviceId: 'mock-voltra-001', deviceName: 'VTR-Mock', weight: 100 };
const BOOT_SETTLE_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;
const AWAIT_CHANNEL_TIMEOUT_MS = 15000;
const SCAN_REFERENCE = '$scan.firstDeviceId';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { exchange: null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--exchange') args.exchange = path.resolve(value);
    else if (argv[i] === '--out') args.out = path.resolve(value);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.exchange || !args.out) throw new Error('usage: --exchange <path> --out <path>');
  return args;
}

/** The exporter never drives hardware: a caller asking for any other adapter is refused. */
function assertMockAdapter(env) {
  const adapter = env.VOLTRA_ADAPTER;
  if (adapter !== undefined && adapter !== 'mock') {
    throw new Error(`refusing VOLTRA_ADAPTER="${adapter}": the exporter runs on mock only`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isolatedEnv(scratchDir, controlPort) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: scratchDir,
    TZ: 'UTC',
    VOLTRA_ADAPTER: 'mock',
    VMCP_LOG_LEVEL: 'error',
    VMCP_DB_PATH: path.join(scratchDir, 'transcript.sqlite'),
    VMCP_SLOT_BINDINGS_PATH: path.join(scratchDir, 'slot-bindings.json'),
    VMCP_CAPTURE_DIR: path.join(scratchDir, 'captures'),
    VMCP_DASHBOARD_PORT: 'off',
    VMCP_AUTO_ARM: 'off',
    VMCP_REST_TIMER: 'off',
    VMCP_CUES: 'off',
    VMCP_MOCK_CONTROL_PORT: String(controlPort),
    VMCP_MOCK_DEVICES: JSON.stringify([{ ...MOCK_DEVICE, ...pinnedConnectProfile() }]),
  };
}

function spawnServer(scratchDir, controlPort) {
  const imports = PRELOADS.flatMap((preload) => ['--import', preload]);
  return spawn(process.execPath, [...imports, BIN_PATH], {
    cwd: REPO_ROOT,
    env: isolatedEnv(scratchDir, controlPort),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── stdio JSON-RPC, keeping the id-less channel pushes ─────────────────────

function createClient(child, onChannel) {
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const route = (message) => {
    if (message.method === 'notifications/claude/channel') return onChannel(message.params);
    const waiter = pending.get(message.id);
    if (!waiter) return undefined;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    return waiter.resolve(message);
  };
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) route(parseLine(line));
    }
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('the server exited'));
  });
  let nextId = 1;
  return function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  };
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
}

/** Pushes queued per event type in arrival order; each await takes the oldest unread ones. */
function createChannelInbox() {
  const queues = new Map();
  const read = new Map();
  return {
    receive(params) {
      const event = params?.meta?.event_type;
      if (typeof event !== 'string') return;
      if (!queues.has(event)) queues.set(event, []);
      queues.get(event).push({ content: params.content, meta: params.meta });
    },
    async take(event, count) {
      const deadline = Date.now() + AWAIT_CHANNEL_TIMEOUT_MS;
      const start = read.get(event) ?? 0;
      while ((queues.get(event)?.length ?? 0) - start < count) {
        if (Date.now() >= deadline) throw new Error(`no ${count} "${event}" push(es) in time`);
        await sleep(50);
      }
      read.set(event, start + count);
      return queues.get(event).slice(start, start + count);
    },
  };
}

// ── tool calls ─────────────────────────────────────────────────────────────

function parseText(result) {
  const text = result?.content?.find((block) => block.type === 'text')?.text;
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

/** A tool result as the redaction module sees it: error code or value, never message text. */
async function callTool(request, name, args) {
  const response = await request('tools/call', { name, arguments: args });
  if (response.error) throw new Error(`${name} failed at the transport (${response.error.code})`);
  const result = response.result;
  if (result?.isError) {
    const code = parseText(result)?.code;
    return { isError: true, errorCode: typeof code === 'string' ? code : undefined, value: null };
  }
  return { isError: false, value: result?.structuredContent ?? parseText(result) };
}

async function handshake(request, child) {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'export-agent-transcript', version: '1' },
  });
  if (init.error) throw new Error('initialize failed');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // The bootstrap swaps placeholder handlers for real ones after the handshake.
  await sleep(BOOT_SETTLE_MS);
  const listed = await request('tools/list', {});
  if (listed.error) throw new Error('tools/list failed');
  return { tools: listed.result.tools };
}

/** The server confirms its own adapter; the transcript records the version it reports. */
async function serverVersionOnMock(request) {
  const health = await callTool(request, 'server.health', {});
  if (health.isError || health.value?.adapter !== 'mock') {
    throw new Error('refusing to export: the server did not report the mock adapter');
  }
  return String(health.value.version);
}

// ── the exchange ───────────────────────────────────────────────────────────

/** Refuse an unknown tool before any step runs. */
function assertToolsListed(exchange, toolsList) {
  const names = new Set(toolsList.tools.map((tool) => tool.name));
  for (const step of exchange.steps) {
    if ('call' in step && !names.has(step.call)) {
      throw new Error(`${step.call} is not in tools/list`);
    }
  }
}

function resolveArgs(args, context) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== 'string' || !value.startsWith('$')) return [key, value];
      if (value !== SCAN_REFERENCE) throw new Error(`unknown reference in "${key}"`);
      if (context.firstDeviceId === undefined) throw new Error('no device.scan result to refer to');
      return [key, context.firstDeviceId];
    }),
  );
}

/** Stage management after a call: park the device on connect, release one burst per set. */
async function afterCall(step, outcome, context) {
  if (outcome.isError) return;
  if (step.call === 'device.scan') context.firstDeviceId = outcome.value?.devices?.[0]?.id;
  if (step.call === 'device.connect') {
    context.deviceId = step.args.deviceId;
    // Wait out the one rep the adapter streams on connect, before any set is open.
    await sleep(burstDurationMs(1) + 1500);
    if (context.pinnedReps)
      await armBursts(context.controlPort, context.deviceId, context.pinnedReps);
  }
  if (step.call === 'set.start' && context.pinnedReps && context.deviceId) {
    await releaseBurst(context.controlPort, context.deviceId, context.pinnedReps);
  }
}

async function runStep(step, request, inbox, context) {
  if ('user' in step || 'assistant' in step) return step;
  if ('awaitChannel' in step) {
    return { step, notifications: await inbox.take(step.awaitChannel, step.count) };
  }
  const resolved = { ...step, args: resolveArgs(step.args, context) };
  const outcome = await callTool(request, resolved.call, resolved.args);
  await afterCall(resolved, outcome, context);
  return { step: resolved, outcome };
}

async function record(exchange, scratchDir) {
  const controlPort = await freePort();
  const child = spawnServer(scratchDir, controlPort);
  child.stderr.resume();
  const inbox = createChannelInbox();
  try {
    const request = createClient(child, (params) => inbox.receive(params));
    const toolsList = await handshake(request, child);
    assertToolsListed(exchange, toolsList);
    const serverVersion = await serverVersionOnMock(request);
    const context = { controlPort, pinnedReps: exchange.pinnedReps };
    const steps = [];
    for (const step of exchange.steps) steps.push(await runStep(step, request, inbox, context));
    return {
      recording: { exchange: exchange.exchange, sourceKind: 'mock', serverVersion, steps },
      toolsList,
    };
  } finally {
    child.kill();
  }
}

async function main() {
  assertMockAdapter(process.env);
  const args = parseArgs(process.argv.slice(2));
  const transcript = await import(TRANSCRIPT_MODULE);
  const exchange = transcript.exchangeScriptSchema.parse(
    JSON.parse(readFileSync(args.exchange, 'utf8')),
  );
  // Refuse a disallowed tool by name before the server is even booted.
  for (const step of exchange.steps) if ('call' in step) transcript.assertToolAllowed(step.call);
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'vmcp-transcript-'));
  try {
    const { recording, toolsList } = await record(exchange, scratchDir);
    const text = transcript.serializeTranscript(transcript.buildTranscript(recording, toolsList));
    const staging = `${args.out}.partial`;
    writeFileSync(staging, text);
    renameSync(staging, args.out);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[export-agent-transcript] FAIL: ${error.message}`);
    process.exit(1);
  },
);
