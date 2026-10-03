#!/usr/bin/env node
// Measure what the voltras-mcp surface costs a client in context (VW-831).
//
// Built like `scripts/gen-tool-reference.mjs`: boot `dist/bin.js` on the mock
// adapter over a scratch store seeded from `src/docs/preview-seeds.ts`, read
// `tools/list`, then replay three scripted journeys and count every tool
// response and push event with the offline estimator in
// `scripts/lib/token-budget-core.mjs`. The clock is pinned and every set is a
// pinned mock burst (`scripts/lib/mock-burst.mjs`), so the table repeats run to run.
//
// Usage: node scripts/token-budget.mjs           # write docs/token-budget.md
//        node scripts/token-budget.mjs --check   # fail if the surface outgrew it
//        node scripts/token-budget.mjs --dump <dir>  # also write each journey's raw captures

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createClient, initialize, unwrap } from './lib/mcp-stdio-client.mjs';
import {
  armBursts,
  burstDurationMs,
  pinnedConnectProfile,
  releaseBurst,
} from './lib/mock-burst.mjs';
import { probeFreePort, sleep } from './lib/dashboard-launch.mjs';
import {
  childEnv,
  compareBudgets,
  maskPaths,
  parseBudget,
  renderBudget,
  summarize,
  toolsListRows,
} from './lib/token-budget-core.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');
const BUDGET_PATH = path.join(REPO_ROOT, 'docs/token-budget.md');
const CLOCK_PRELOAD = path.join(REPO_ROOT, 'scripts/fixed-clock-preload.mjs');
const PRELOADS = [
  CLOCK_PRELOAD,
  path.join(REPO_ROOT, 'scripts/mock-settings-echo-preload.mjs'),
  path.join(REPO_ROOT, 'scripts/mock-two-slot-preload.mjs'),
].flatMap((file) => ['--import', file]);
/** A Sunday morning, so the sitting reads as one. */
const PINNED_NOW = Date.parse('2026-06-14T10:00:00.000Z');
const BOOT_SETTLE_MS = 2000;
const EVENT_TIMEOUT_MS = 60_000;
const SETTLE_MS = 1000;
const DEVICE_ID = 'mock-voltra-001';
const EXERCISE_ID = 'cable-chest-press';
const REPS_PER_SET = 8;
const SETS = 2;
const CHANNEL_METHOD = 'notifications/claude/channel';

function parseArgs(argv) {
  const args = { check: false, out: BUDGET_PATH, dump: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--dump') args.dump = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/** UTC and a shifted clock in this process too, so the seed and the server share one timeline. */
async function pinClock() {
  process.env.TZ = 'UTC';
  process.env.VMCP_CLOCK_OFFSET_MS = String(PINNED_NOW - Date.now());
  await import(CLOCK_PRELOAD);
}

/** Seed the store and close it before any server opens the same file. */
async function seedStore(dbPath) {
  const { SqliteSessionStore } = await import(path.join(REPO_ROOT, 'dist/store/sqlite-store.js'));
  const { goalPreviewState, seedGoalPreview } = await import(
    path.join(REPO_ROOT, 'dist/docs/preview-seeds.js')
  );
  const store = SqliteSessionStore.open(dbPath);
  try {
    return await seedGoalPreview(store, goalPreviewState('on_track'), new Date(), {
      companions: true,
      wholeBody: true,
      unreviewedDays: 3,
    });
  } finally {
    store.close();
  }
}

/** An allowlisted env (see `childEnv`), with HOME inside the scratch dir. */
function serverEnv(scratchDir, controlPort) {
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(home);
  return childEnv(process.env, home, {
    TZ: 'UTC',
    VMCP_CLOCK_OFFSET_MS: process.env.VMCP_CLOCK_OFFSET_MS,
    VOLTRA_ADAPTER: 'mock',
    VMCP_LOG_LEVEL: 'error',
    VMCP_DB_PATH: path.join(scratchDir, 'budget.sqlite'),
    VMCP_SLOT_BINDINGS_PATH: path.join(scratchDir, 'slot-bindings.json'),
    VMCP_DASHBOARD_PORT: 'off',
    VMCP_MOCK_CONTROL_PORT: String(controlPort),
    VMCP_MOCK_DEVICES: JSON.stringify([
      { deviceId: DEVICE_ID, deviceName: 'VTR-Mock', weight: 100, ...pinnedConnectProfile() },
    ]),
  });
}

/** Every spelling of the temp dirs a capture can name, so none reaches a count. */
function tempRoots(scratchDir) {
  const roots = [scratchDir, os.tmpdir()];
  return [...roots, ...roots.map((root) => fs.realpathSync(root))];
}

/** The text a push event puts in context: its meta attributes and its JSON content. */
function pushText(params) {
  let content = params.content;
  try {
    content = JSON.parse(params.content);
  } catch {
    // A prose push is counted as it stands.
  }
  return JSON.stringify([params.meta ?? {}, content]);
}

/** Boot one server on a seeded scratch store; every response and push is recorded. */
async function bootServer(scratchDir) {
  const controlPort = await probeFreePort();
  const child = spawn(process.execPath, [...PRELOADS, BIN_PATH], {
    cwd: REPO_ROOT,
    env: serverEnv(scratchDir, controlPort),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pushes = [];
  const roots = tempRoots(scratchDir);
  const onNotification = (message) => {
    if (message.method !== CHANNEL_METHOD) return;
    pushes.push({
      key: message.params.meta?.event_type ?? 'untyped',
      text: maskPaths(pushText(message.params), roots),
    });
  };
  const request = createClient(child, { onNotification });
  await initialize(child, request, 'token-budget');
  await sleep(BOOT_SETTLE_MS);
  return { child, request, controlPort, pushes, roots, responses: [] };
}

/** Call one tool, record its text, and return it parsed when it is JSON. */
async function call(server, name, args = {}) {
  const result = unwrap(await server.request('tools/call', { name, arguments: args }), name);
  const text = result.content.map((item) => item.text ?? '').join('');
  if (result.isError) throw new Error(`${name} returned an error: ${text.slice(0, 200)}`);
  server.responses.push({ key: name, text: maskPaths(text, server.roots) });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitForPushes(server, eventType, count) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  const seen = () => server.pushes.filter((push) => push.key === eventType).length;
  while (seen() < count) {
    if (Date.now() > deadline) throw new Error(`waited for ${count} ${eventType}, saw ${seen()}`);
    await sleep(100);
  }
}

/** One pinned set of exactly {@link REPS_PER_SET} reps, closed once its last rep is final. */
async function liveSet(server, setNumber) {
  await armBursts(server.controlPort, DEVICE_ID, REPS_PER_SET);
  const { setId } = await call(server, 'set.start', {
    watch: {
      notifyOn: [
        { type: 'rep_count_reached', value: REPS_PER_SET - 2 },
        { type: 'velocity_loss_exceeded', pct: 1 },
      ],
    },
  });
  await releaseBurst(server.controlPort, DEVICE_ID, REPS_PER_SET);
  // The last rep is only final once the set closes, so wait out its stroke instead.
  await waitForPushes(server, 'rep_finalized', REPS_PER_SET * setNumber - 1);
  await sleep(burstDurationMs(1) + SETTLE_MS);
  await call(server, 'set.end');
  await waitForPushes(server, 'set_ended', setNumber);
  await waitForPushes(server, 'rep_finalized', REPS_PER_SET * setNumber);
  return setId;
}

async function connectDevice(server) {
  await call(server, 'device.scan');
  await call(server, 'device.connect', { deviceId: DEVICE_ID });
  // The pinned profile streams one rep on connect, then parks; let it finish first.
  await sleep(burstDurationMs(1) + SETTLE_MS);
  await call(server, 'device.set_mode', { mode: 'WeightTraining' });
  await call(server, 'device.set_weight', { lbs: 100 });
  await call(server, 'device.get_state');
}

/** Journey A: a short live workout, two sets of eight with triggers and a load change. */
async function liveWorkout(server) {
  await call(server, 'server.health');
  await call(server, 'plan.next_workout');
  await call(server, 'exercise.search', { query: 'chest press' });
  await connectDevice(server);
  const { sessionId } = await call(server, 'session.start', { exerciseId: EXERCISE_ID });
  let lastSetId;
  for (let setNumber = 1; setNumber <= SETS; setNumber++) {
    lastSetId = await liveSet(server, setNumber);
    if (setNumber < SETS) await call(server, 'device.set_weight', { lbs: 100 + 5 * setNumber });
  }
  await call(server, 'set.get', { setId: lastSetId });
  await call(server, 'device.get_state');
  await call(server, 'progression.get_for_exercise', { exerciseId: EXERCISE_ID });
  await call(server, 'session.end');
  await call(server, 'report.session_results', { sessionId });
}

/** Journey B: the Sunday sitting, reads first, then the week's inputs and goals. */
async function sundaySitting(server, seed) {
  for (const name of [
    'server.health',
    'plan.current_block',
    'goal.list',
    'profile.get_onboarding_gaps',
    'profile.get_body_metrics',
    'profile.get_training_background',
  ]) {
    await call(server, name);
  }
  const review = await call(server, 'session.review_list');
  const days = review.days.map((entry) => entry.day).sort();
  await call(server, 'session.mark_kind', {
    kind: 'test',
    from: days[0],
    to: days[days.length - 1],
    dryRun: true,
  });
  await call(server, 'profile.log_bodyweight', { bodyweightLbs: 180 });
  await call(server, 'profile.get_tier_signal');
  await call(server, 'profile.log_weekly_checkin', WEEKLY_CHECKIN);
  await call(server, 'plan.block.planning_brief');
  await call(server, 'goal.propose_targets', { priorityId: seed.priorityId });
  await call(server, 'accountability.declare_commitment', COMMITMENT);
  await call(server, 'accountability.preview');
  await call(server, 'plan.next_workout');
}

const WEEKLY_CHECKIN = { hunger: 'medium', dietPlanAdherence: 'high', sleepQuality: 'medium' };
const COMMITMENT = {
  days: [
    { day: 'Monday', fallbackDay: 'Tuesday' },
    { day: 'Thursday', fallbackDay: 'Friday' },
  ],
  ifThen: 'If work runs late, then I train the next morning.',
  wording: 'Two sessions this week, no matter what.',
};

/** Journey C: the weekly review from the Sunday review script. */
async function weeklyReview(server) {
  await call(server, 'server.health');
  await call(server, 'session.review_list');
  await call(server, 'profile.log_bodyweight', { bodyweightLbs: 180 });
  await call(server, 'profile.log_weekly_checkin', WEEKLY_CHECKIN);
  await call(server, 'goal.weekly_review');
  await call(server, 'report.weekly');
  await call(server, 'plan.current_block');
}

const JOURNEYS = [
  { name: 'live-workout', run: liveWorkout },
  { name: 'sunday-sitting', run: sundaySitting },
  { name: 'weekly-review', run: weeklyReview },
];

/** Run `body` against a freshly seeded server, and always tear both down. */
async function withServer(body) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-budget-'));
  let server;
  try {
    const seed = await seedStore(path.join(scratchDir, 'budget.sqlite'));
    server = await bootServer(scratchDir);
    return await body(server, seed);
  } finally {
    server?.child.kill();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Raw captures for a local look at what fills a row; never committed, since they hold payloads. */
function dumpJourney(dumpDir, name, server) {
  fs.mkdirSync(dumpDir, { recursive: true });
  const captures = { responses: server.responses, pushEvents: server.pushes };
  fs.writeFileSync(path.join(dumpDir, `${name}.json`), `${JSON.stringify(captures, null, 1)}\n`);
}

async function measure(dumpDir) {
  const toolsList = await withServer(async (server) =>
    toolsListRows(unwrap(await server.request('tools/list', {}), 'tools/list').tools),
  );
  const journeys = [];
  for (const journey of JOURNEYS) {
    const measured = await withServer(async (server, seed) => {
      await journey.run(server, seed);
      if (dumpDir !== null) dumpJourney(dumpDir, journey.name, server);
      return { responses: summarize(server.responses), pushEvents: summarize(server.pushes) };
    });
    journeys.push({ name: journey.name, ...measured });
  }
  return { toolsList, journeys };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(BIN_PATH)) throw new Error('dist/bin.js is missing; run `npm run build`');
  await pinClock();
  const budget = await measure(args.dump);
  if (!args.check) {
    fs.writeFileSync(args.out, renderBudget(budget));
    console.log(`[budget] wrote ${path.relative(REPO_ROOT, args.out)}`);
    return;
  }
  const failures = compareBudgets(parseBudget(fs.readFileSync(args.out, 'utf8')), budget);
  if (failures.length === 0) {
    console.log('[budget] within the committed table');
    return;
  }
  console.error(
    `[budget] ${failures.length} over budget; regenerate with node scripts/token-budget.mjs if intended:`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[budget] ${error.message}`);
  process.exit(1);
});
