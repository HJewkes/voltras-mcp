#!/usr/bin/env node
// dashboard-body-seed: the capture driver behind the `#/body` shot (VW-338).
//
// ── Why this is not one of the workout drivers ────────────────────────────
// Every other capture scenario drives the real MCP pipeline with
// `VOLTRA_ADAPTER=mock`, and `set.end` stamps those sets `source: 'mock'`. The
// per-muscle read models behind the body page EXCLUDE mock sets by design
// (`read-models/muscle-set-scope.ts`, `isEligibleWorkingSet`) — a synthetic set
// must never show up as this athlete's training volume. So a mock-driven run
// renders the body page fully empty: no figure fill, no PR, no next-up. That is
// correct behaviour and a useless published screenshot.
//
// This driver therefore writes the STORE directly — a plausible training week
// of owner-owned, non-mock sets plus the plan tree around them — and then boots
// the same `dist/bin.js` the `cold` scenario does over that store. Nothing here
// fabricates telemetry: it seeds recorded outcomes (sets, loads, rep counts,
// planned targets), which is exactly what the three `/api/muscle-*` read models
// project. The analytics on top of them (e1RM, slope, PR) are the real ones.
//
// Every value is a literal, and every timestamp is derived from the CURRENT
// calendar week, so the seeded page is identical run to run — the property the
// `expectValues` assertions in `src/docs/capture-shots.ts` depend on. The week's
// DATE moves with the wall clock and is never asserted, same convention as the
// live page's header clock.
//
// Confidentiality: exercise names, loads and rep counts only — derived fitness
// metadata, no protocol data of any kind (NF-07).
//
// Takes no arguments: `VMCP_DB_PATH` and `VMCP_DASHBOARD_PORT` come from the
// harness's own per-scenario environment. To drive it by hand:
//   VMCP_DB_PATH=/tmp/body.sqlite VMCP_DASHBOARD_PORT=7724 \
//     node scripts/dashboard-body-seed.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist', 'bin.js');

const { SqliteSessionStore } = await import(path.join(REPO_ROOT, 'dist/store/sqlite-store.js'));
const { MUSCLE_MAP_VERSION } = await import(path.join(REPO_ROOT, 'dist/exercises/muscle-map.js'));

/** Monday 00:00 UTC of the week containing `date`. Matches `startOfCalendarWeekIso`. */
function weekStart(date) {
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = midnight.getUTCDay() === 0 ? 7 : midnight.getUTCDay();
  midnight.setUTCDate(midnight.getUTCDate() - (isoDay - 1));
  return midnight;
}

/**
 * `base` shifted by whole days, as an ISO instant, never later than a minute
 * ago. The clamp is what makes the seed weekday-independent: this week's third
 * training day has not happened yet on a Tuesday, and `/api/muscle-strength`
 * bounds its window at `now`, so an unclamped stamp would silently drop a
 * session from the PR list on some days and not others. Which INSTANT a set
 * carries is never asserted; how many there are is.
 */
function at(base, days, hour = 17) {
  const when = new Date(base);
  when.setUTCDate(when.getUTCDate() + days);
  when.setUTCHours(hour, 0, 0, 0);
  // Ten minutes of headroom, so the per-set offsets below stay in the past too.
  const latest = Date.now() - 10 * 60_000;
  return new Date(Math.min(when.getTime(), latest)).toISOString();
}

/**
 * The seeded week. Loads climb across the four prior weeks so `history.trend`
 * has a real slope to fit and the last week's top set is a genuine e1RM PR —
 * nothing here declares a PR, the read model decides.
 *
 * Muscle coverage is deliberately uneven: chest lands inside its productive
 * band, back and biceps below MEV, legs untouched. A figure where every muscle
 * is the same colour proves nothing about the status scale.
 */
const PROGRESSION_WEEKS = [
  { weeksAgo: 4, chest: 150, row: 130, curl: 40 },
  { weeksAgo: 3, chest: 155, row: 135, curl: 42.5 },
  { weeksAgo: 2, chest: 160, row: 140, curl: 45 },
  { weeksAgo: 1, chest: 165, row: 145, curl: 47.5 },
  { weeksAgo: 0, chest: 175, row: 150, curl: 50 },
];

/** This week's working sets, per exercise. Chest gets the volume; the rest stay light. */
const THIS_WEEK_SETS = [
  { exerciseId: 'cable-chest-press', name: 'Cable Chest Press', day: 0, sets: 6, reps: 8 },
  {
    exerciseId: 'cable-incline-chest-press',
    name: 'Cable Incline Chest Press',
    day: 0,
    sets: 5,
    reps: 10,
  },
  { exerciseId: 'cable-chest-fly', name: 'Cable Chest Fly', day: 2, sets: 4, reps: 12 },
  { exerciseId: 'cable-row', name: 'Cable Row', day: 1, sets: 4, reps: 10 },
  { exerciseId: 'cable-bicep-curl', name: 'Cable Bicep Curl', day: 1, sets: 3, reps: 12 },
  { exerciseId: 'cable-lateral-raise', name: 'Cable Lateral Raise', day: 2, sets: 2, reps: 15 },
];

/** The load each of this week's exercises was worked at. */
const THIS_WEEK_LOAD = {
  'cable-chest-press': 175,
  'cable-incline-chest-press': 120,
  'cable-chest-fly': 55,
  'cable-row': 150,
  'cable-bicep-curl': 50,
  'cable-lateral-raise': 30,
};

let sessionSeq = 0;
let setSeq = 0;

async function putSession(store, startedAt, exerciseId, exerciseName) {
  sessionSeq += 1;
  const id = `body-seed-session-${sessionSeq}`;
  await store.putSession({
    id,
    startedAt,
    endedAt: startedAt,
    exerciseId,
    exerciseName,
    catalogVersion: MUSCLE_MAP_VERSION,
  });
  return id;
}

async function putSets(store, sessionId, startedAt, exerciseId, count, reps, weightLbs) {
  for (let index = 0; index < count; index += 1) {
    setSeq += 1;
    // Twenty seconds apart, so six sets span under two minutes and stay inside
    // both the session's own day and the ten-minute headroom `at` leaves.
    const when = new Date(startedAt);
    when.setUTCSeconds(when.getUTCSeconds() + index * 20);
    const iso = when.toISOString();
    await store.putSet({
      id: `body-seed-set-${setSeq}`,
      sessionId,
      startedAt: iso,
      endedAt: iso,
      partial: false,
      reps: [],
      exerciseId,
      firmwareRepCount: reps,
      weightLbs,
      setPurpose: 'working',
      trainingMode: 'weight',
      // NOT 'mock': these stand in for the owner's own recorded work, which is
      // the only thing the per-muscle read models count. See this file's header.
      source: 'local',
    });
  }
}

/** The four prior weeks of the three tracked lifts — the slope the PR is measured against. */
async function seedHistory(store, monday) {
  for (const week of PROGRESSION_WEEKS) {
    if (week.weeksAgo === 0) continue;
    const base = new Date(monday);
    base.setUTCDate(base.getUTCDate() - week.weeksAgo * 7);
    for (const [exerciseId, name, day, load, reps] of [
      ['cable-chest-press', 'Cable Chest Press', 0, week.chest, 8],
      ['cable-row', 'Cable Row', 1, week.row, 10],
      ['cable-bicep-curl', 'Cable Bicep Curl', 1, week.curl, 12],
    ]) {
      const startedAt = at(base, day);
      const sessionId = await putSession(store, startedAt, exerciseId, name);
      await putSets(store, sessionId, startedAt, exerciseId, 3, reps, load);
    }
  }
}

/** This week's sessions — the ones the figure, the strip and the tiles read. */
async function seedThisWeek(store, monday) {
  for (const row of THIS_WEEK_SETS) {
    const startedAt = at(monday, row.day);
    const sessionId = await putSession(store, startedAt, row.exerciseId, row.name);
    await putSets(
      store,
      sessionId,
      startedAt,
      row.exerciseId,
      row.sets,
      row.reps,
      THIS_WEEK_LOAD[row.exerciseId],
    );
  }
}

/**
 * The plan tree behind NEXT UP. `Pull B` is left with no completed assignment
 * on purpose: `/api/muscle-plan` reports the first week that still has an
 * unfinished workout, so an all-complete week 404s and the panel goes empty.
 */
async function seedPlan(store, monday) {
  const createdAt = at(monday, -28);
  await store.putTrainingProgram({ id: 'body-seed-program', name: 'Hypertrophy', createdAt });
  await store.putTrainingBlock({
    id: 'body-seed-block',
    programId: 'body-seed-program',
    orderIndex: 0,
    name: 'Block 2',
    weeksCount: 5,
  });
  await store.putTrainingWeek({
    id: 'body-seed-week',
    blockId: 'body-seed-block',
    orderIndex: 2,
    isDeload: false,
    weekIndex: 3,
  });
  await store.putWorkoutTemplate({
    id: 'body-seed-pull-b',
    weekId: 'body-seed-week',
    name: 'Pull B',
    orderIndex: 0,
  });
  const planned = [
    ['cable-lat-pulldown', 0, 4, 8, 10, 120],
    ['cable-row', 1, 3, 8, 10, 150],
    ['cable-hammer-curl', 2, 3, 10, 12, 45],
  ];
  for (const [exerciseId, orderIndex, targetSets, low, high, weight] of planned) {
    await store.putPlannedExercise({
      id: `body-seed-planned-${exerciseId}`,
      workoutTemplateId: 'body-seed-pull-b',
      exerciseId,
      orderIndex,
      targetSets,
      targetRepsLow: low,
      targetRepsHigh: high,
      targetWeightLbs: weight,
    });
  }
}

async function seed(dbPath) {
  const store = SqliteSessionStore.open(dbPath);
  try {
    const monday = weekStart(new Date());
    await seedPlan(store, monday);
    await seedHistory(store, monday);
    await seedThisWeek(store, monday);
  } finally {
    store.close();
  }
}

/** The MCP initialize the server needs before it boots its dashboard sidecar. */
function handshake(child) {
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dashboard-body-seed', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function main() {
  const dbPath = process.env.VMCP_DB_PATH;
  if (!dbPath) throw new Error('VMCP_DB_PATH is required — refusing to guess a store path');
  if (dbPath.includes('.voltras')) throw new Error('refusing to seed the real store');
  await seed(dbPath);
  console.log(`[body-seed] seeded ${setSeq} sets across ${sessionSeq} sessions into ${dbPath}`);

  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  handshake(child);
  const stop = () => {
    child.stdin.end();
    child.kill('SIGKILL');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error('[body-seed] FAIL:', err.message);
  process.exit(1);
});
