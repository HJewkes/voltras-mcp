#!/usr/bin/env node
// dashboard-plan-drive: REAL-pipeline no-hardware loop for a PLANNED workout.
//
// `dashboard-mock-drive.mjs` drives the real MCP pipeline but starts a bare
// single-exercise session with no plan attached, so `/api/session-plan` returns
// null and everything downstream of a prescription — the header's
// `sets x reps @ load` lockup, its prescribed tempo, the strip's `todo` columns,
// the rail's `upcoming` rows — has never run end to end. This driver fills that
// gap. It is a SIBLING of that script, not a replacement: that one stays the
// minimal unplanned path.
//
// The plan is seeded through the REAL `plan.*` MCP tools
// (program -> block -> week -> template -> planned_exercises) and bound with
// `plan.attach_to_session`, so `fetchSessionPlan` resolves it by genuinely
// walking the store. Nothing is stubbed at the HTTP layer — a canned
// `/api/session-plan` response would prove only that the SPA can render a
// fixture, which is exactly what this exists to stop doing.
//
// ── Why one session per exercise ───────────────────────────────────────────
// `session.start` throws SESSION_ALREADY_ACTIVE while a session is open and the
// exercise is fixed at start; there is no `session.set_exercise` tool. So
// advancing to the next planned exercise means `session.end` then
// `session.start` with the next `exerciseId`, re-attaching the SAME template.
// The rail's `upcoming` rows come from the template (not the session), so they
// still render correctly — but each session only carries its OWN completed sets,
// so an exercise already finished shows as a done row with an empty strip.
// That is a product gap this driver EXPOSES, not one it papers over.
//
// ── Load variation, and what the mock cannot give us ───────────────────────
// Each planned exercise carries its own target load (140 / 95 / 45 lb), so the
// PRESCRIBED load varies across the run and the header + rail rows are driven
// through a real range rather than one constant.
//
// The LIVE load does not vary, and cannot: `device.weightLbs` reaches the
// snapshot from the settings cascade (cmd=0x10), which MockBLEAdapter never
// emits — the mock's `weight` config is simulator input, not a cascade echo, so
// no amount of driving makes it appear. `/api/snapshot` therefore reports a
// device with no weight at all under mock. That is a real gap the wall has to
// degrade around, and this driver renders that degradation honestly rather than
// faking a cascade.
//
// It boots with `mock-two-slot-preload.mjs` (used as-is) pinned to a SINGLE
// device via `VMCP_MOCK_DEVICES`, because stock `VOLTRA_ADAPTER=mock` hardcodes
// one fixed device id and this driver wants its own.
//
// Usage:
//   npm run build && npm run build:dashboard
//   node scripts/dashboard-plan-drive.mjs                 # :7726, holds open
//   node scripts/dashboard-plan-drive.mjs --port=7810 --sets=3
//   HOLD=0 node scripts/dashboard-plan-drive.mjs          # exit after the workout
//
// Open http://127.0.0.1:<port>/app BEFORE/DURING the run — the set log
// accumulates client-side across polls.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../dist/bin.js');
const preloadPath = path.resolve(__dirname, 'mock-two-slot-preload.mjs');

const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const flag = (name, fallback) => flags.get(name) ?? fallback;

const PORT = Number(flag('port', process.env.VMCP_DASHBOARD_PORT ?? 7726));
const CONTROL_PORT = Number(flag('control-port', 7737));
/** Seconds of reps per set — the mock streams continuously, so dwell sets the rep count. */
const DWELL_MS = Number(flag('dwell-ms', process.env.DWELL_MS ?? 8000));
const REST_MS = Number(flag('rest-ms', process.env.REST_MS ?? 5000));
const HOLD = flag('hold', process.env.HOLD ?? '1') !== '0';
const DB_PATH =
  process.env.VMCP_DB_PATH ?? path.join(os.tmpdir(), `vmcp-plan-drive-${PORT}.sqlite`);
const DEVICE_ID = 'mock-voltra-plan';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[plan]', ...a);

// ── the prescription ───────────────────────────────────────────────────────
//
// Three seeded-catalog exercises so the rail has real `upcoming` rows to dim and
// something to promote as the session advances; multiple sets each so the strip
// genuinely walks `todo -> active -> done`; and a different load and rep target
// per exercise so the load/prescription cells are exercised rather than constant.
// `sets` is deliberately > what the run completes on the last exercise, so a
// partially-finished exercise is on screen too.
const PLANNED = [
  {
    exerciseId: 'cable-chest-press',
    sets: 3,
    repsLow: 8,
    repsHigh: 10,
    weightLbs: 140,
    restSec: 90,
  },
  { exerciseId: 'cable-incline-chest-press', sets: 3, repsLow: 10, weightLbs: 95, restSec: 75 },
  { exerciseId: 'cable-chest-fly', sets: 2, repsLow: 12, repsHigh: 15, weightLbs: 45, restSec: 60 },
];
/** Sets actually performed per exercise — below `targetSets` so `todo` columns survive. */
const SETS_PER_EXERCISE = Number(flag('sets', process.env.SETS ?? 2));

const child = spawn(process.execPath, ['--import', preloadPath, binPath], {
  env: {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(PORT),
    VMCP_DB_PATH: DB_PATH,
    VMCP_REST_TIMER: 'on',
    VMCP_MOCK_CONTROL_PORT: String(CONTROL_PORT),
    // A single device: the preload advertises whatever this lists, and a dual
    // scan would leave an unbound second slot on a single-Voltra demo.
    VMCP_MOCK_DEVICES: JSON.stringify([
      {
        deviceId: DEVICE_ID,
        deviceName: 'VTR-MockPlan',
        weight: PLANNED[0].weightLbs,
        repsPerSet: 8,
      },
    ]),
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
      const pending = msg.id != null ? responses.get(msg.id) : undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        responses.delete(msg.id);
        pending.resolve(msg);
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
    console.error(`[plan] mcp exited code ${code}`);
    if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
    process.exit(1);
  }
});

/** Unwrap a tools/call response into its structured payload; throw on tool error. */
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

/** The prescription as the SPA reads it — the endpoint this whole driver exists to light up. */
async function sessionPlan() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/session-plan`);
  if (!res.ok) throw new Error(`/api/session-plan ${res.status}`);
  return (await res.json()).plan;
}

function summarize(snap, label) {
  const set = snap.sets?.active;
  const name = snap.session?.exerciseName ?? snap.session?.exerciseId ?? 'none';
  const reps = set ? (set.reps?.length ?? set.repCount ?? 0) : '—';
  // `weightLbs` is absent under mock (no settings cascade) — printed so the run log
  // states that plainly rather than leaving it looking unchecked.
  const weight = snap.devices?.[0]?.device?.weightLbs ?? 'no-cascade';
  log(`${label} | rev=${snap.rev} session=${name} load=${weight} reps=${reps}`);
}

// ── plan seeding, through the real tools ───────────────────────────────────

/**
 * Seed program -> block -> week -> template -> planned exercises and return the
 * template id. Every row goes in through the `plan.*` MCP tools, so the store
 * ends up in exactly the shape `fetchSessionPlan` walks.
 */
async function seedPlan() {
  const { program } = await callTool('plan.program.create', {
    name: 'Mock Hypertrophy',
    description: 'Seeded by dashboard-plan-drive for real-pipeline verification.',
  });
  const { block } = await callTool('plan.block.create', {
    programId: program.id,
    orderIndex: 0,
    name: 'Block 1',
    focus: 'Hypertrophy',
    weeksCount: 1,
  });
  const { week } = await callTool('plan.week.create', {
    blockId: block.id,
    orderIndex: 0,
    name: 'Week 1',
  });
  const { template } = await callTool('plan.template.create', {
    weekId: week.id,
    name: 'Push A',
    dayLabel: 'Mon',
    orderIndex: 0,
  });
  for (const [i, ex] of PLANNED.entries()) {
    await callTool('plan.exercise.create', {
      workoutTemplateId: template.id,
      exerciseId: ex.exerciseId,
      orderIndex: i,
      targetSets: ex.sets,
      targetRepsLow: ex.repsLow,
      ...(ex.repsHigh !== undefined ? { targetRepsHigh: ex.repsHigh } : {}),
      targetWeightLbs: ex.weightLbs,
      restSec: ex.restSec,
    });
  }
  log(`plan seeded: template ${template.id} with ${PLANNED.length} exercises`);
  return template.id;
}

// ── the workout ────────────────────────────────────────────────────────────

/** One set: start, let the mock accrue reps, end. The mock never auto-closes a set. */
async function runSet(exerciseIndex, setNumber) {
  await callTool('set.start', {});
  await sleep(300);
  summarize(await snapshot(), `ex${exerciseIndex + 1} set ${setNumber} start`);
  await sleep(DWELL_MS);
  summarize(await snapshot(), `ex${exerciseIndex + 1} set ${setNumber} mid  `);
  await callTool('set.end', {});
  summarize(await snapshot(), `ex${exerciseIndex + 1} set ${setNumber} end  `);
}

/**
 * One planned exercise: dial the mock to its prescribed load, open a session on
 * it, bind the template, run its sets, close. See the header note on why each
 * exercise needs its own session.
 */
async function runPlannedExercise(exerciseIndex, templateId) {
  const ex = PLANNED[exerciseIndex];
  const { sessionId } = await callTool('session.start', { exerciseId: ex.exerciseId });
  await callTool('plan.attach_to_session', { sessionId, workoutTemplateId: templateId });
  const plan = await sessionPlan();
  if (plan === null) throw new Error(`session-plan did not resolve for ${ex.exerciseId}`);
  log(
    `exercise ${exerciseIndex + 1}/${PLANNED.length} ${ex.exerciseId}: ` +
      `${plan.sets} x ${plan.repsLow}${plan.repsHigh ? `-${plan.repsHigh}` : ''} @ ${plan.weightLbs} lb` +
      `${plan.tempo ? ` tempo ${plan.tempo.join('-')}` : ''}`,
  );

  for (let s = 1; s <= SETS_PER_EXERCISE; s++) {
    await runSet(exerciseIndex, s);
    if (s < SETS_PER_EXERCISE) await sleep(REST_MS);
  }
  await callTool('session.end', {});
  if (exerciseIndex < PLANNED.length - 1) await sleep(REST_MS);
}

async function handshake() {
  const init = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dashboard-plan-drive', version: '0.1.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  log('MCP initialized; waiting for handlers + dashboard bind…');
  await sleep(2000);

  const tools = (await sendRequest('tools/list', {})).result.tools.map((t) => t.name);
  const needed = [
    'device.connect',
    'session.start',
    'set.start',
    'set.end',
    'plan.exercise.create',
    'plan.attach_to_session',
  ];
  for (const need of needed) {
    if (!tools.includes(need)) throw new Error(`missing tool ${need}`);
  }
  log(`dashboard at http://127.0.0.1:${PORT}/app  (open it now)`);
}

async function main() {
  await handshake();
  const scan = await callTool('device.scan', {});
  const devId = scan.devices?.[0]?.id;
  if (devId !== DEVICE_ID) throw new Error(`scan returned ${String(devId)}, expected ${DEVICE_ID}`);
  await callTool('device.connect', { deviceId: devId });
  log(`connected ${devId} — mock telemetry streaming`);
  await sleep(500);

  const templateId = await seedPlan();
  for (let i = 0; i < PLANNED.length; i++) await runPlannedExercise(i, templateId);
  log(`planned workout complete: ${PLANNED.length} exercises through the real pipeline`);

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
  console.error('[plan] FAIL:', err.message);
  if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
  child.kill();
  process.exit(1);
});
