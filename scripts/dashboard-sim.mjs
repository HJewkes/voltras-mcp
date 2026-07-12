#!/usr/bin/env node
// dashboard-sim: no-hardware run→feed→observe dev loop for the dashboard.
//
// Boots the dashboard HTTP sidecar (`startDashboardServer`) against a mutable
// in-process state object that satisfies `DashboardServerState`, then scripts a
// full workout by mutating that state on a timer. No MCP server, no BLE SDK, no
// hardware. The SPA at /app polls /api/snapshot and animates through every
// phase (connect → session → set → reps → rest → next set).
//
// Why this exists: the MCP tool surface can NOT inject rep/set telemetry
// without a device — `set.start` drives a real device client (`startRecording`),
// the `mock.*` tools are notImplemented stubs, and `set.live_metrics` is
// read-only. Driving the dashboard state directly is the same thing the
// integration tests do via `state.live.appendRep`; this wraps it in a live
// server so you can watch the real SPA render it. Doubles as the manual
// counterpart to the automated simulated-session smoke test (VW-38 P4).
//
// Usage:
//   npm run build && npm run dashboard:sim      # defaults to port 7799
//   PORT=7801 node scripts/dashboard-sim.mjs
//   LOOP=1 node scripts/dashboard-sim.mjs       # repeat the workout forever
//
// Then open http://127.0.0.1:<port>/app. The set-log table accumulates
// client-side across polls, so open the page BEFORE (or during) the workout —
// a browser that connects after the last set won't have witnessed the
// non-null→null set transitions it logs from.

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { startDashboardServer } = await import(
  path.resolve(__dirname, '../dist/dashboard/server.js')
);

const PORT = Number(process.env.PORT ?? 7799);
const LOOP = process.env.LOOP === '1';
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mutable live state the dashboard reads ────────────────────────────────
let device = { connected: false };
let session; // ActiveSession | undefined
let set; // ActiveSet | undefined

const state = {
  slots: new Map([
    [
      'primary',
      {
        live: {
          snapshotDevice: () => device,
          snapshotSession: () => session,
          snapshotSet: () => set,
        },
      },
    ],
  ]),
  // Minimal store: no history, no plan preview. Panels degrade gracefully.
  store: {
    listSessions: async () => [],
    getSetsForSession: async () => [],
  },
  // Light up the BodyMap heatmap for the active exercise.
  exercises: {
    getById: (id) =>
      id === 'bench-press'
        ? { muscleGroups: ['chest', 'triceps'], secondaryMuscleGroups: ['shoulders'] }
        : undefined,
  },
};

// ── scripted workout ──────────────────────────────────────────────────────
let repSeq = 0;
const makeRep = (peakMms) => ({
  repNumber: ++repSeq,
  concentric: { peakVelocity: peakMms }, // mm/s; SPA renders m/s
  eccentric: {},
});

async function runSet({ setNumber, weightLbs, repCount, startPeak, restMs }) {
  console.log(`[sim] set ${setNumber} — ${weightLbs} lb, ${repCount} reps`);
  device = { connected: true, weightLbs, trainingMode: 'WeightTraining', batteryPercent: 88 };
  const setId = `sim-set-${setNumber}-${Date.now()}`;
  repSeq = 0;
  set = { setId, sessionId: session.sessionId, startedAt: nowIso(), reps: [], status: 'active' };

  // Reps land ~1.5s apart with velocity decaying across the set (fatigue).
  for (let i = 0; i < repCount; i++) {
    await sleep(1500);
    const peak = Math.round(startPeak - i * (startPeak * 0.06));
    set.reps = [...set.reps, makeRep(peak)];
    console.log(`[sim]   rep ${i + 1}/${repCount} @ ${(peak / 1000).toFixed(2)} m/s`);
  }

  // Close the set: mark ended, record it on the session, then drop to null so
  // the SPA's non-null→null transition logs the completed set into the table.
  set = { ...set, status: 'ended', endedAt: nowIso() };
  session.setIds = [...session.setIds, setId];
  await sleep(800);
  set = undefined;

  console.log(`[sim]   rest ${(restMs / 1000).toFixed(0)}s`);
  await sleep(restMs);
}

async function runWorkout() {
  await sleep(1500);
  console.log('[sim] device connecting…');
  device = { connected: true, weightLbs: 0, trainingMode: 'WeightTraining', batteryPercent: 90 };
  await sleep(1200);

  session = {
    sessionId: `sim-${Date.now()}`,
    startedAt: nowIso(),
    exerciseId: 'bench-press',
    exerciseName: 'Barbell Bench Press',
    setIds: [],
    status: 'active',
  };
  console.log(`[sim] session started ${session.sessionId}`);

  const sets = [
    { setNumber: 1, weightLbs: 135, repCount: 5, startPeak: 820, restMs: 6000 },
    { setNumber: 2, weightLbs: 145, repCount: 5, startPeak: 760, restMs: 6000 },
    { setNumber: 3, weightLbs: 155, repCount: 4, startPeak: 690, restMs: 6000 },
  ];
  for (const s of sets) await runSet(s);
  console.log('[sim] workout complete.');
}

const handle = await startDashboardServer({ port: PORT, state });
console.log(`[sim] dashboard sidecar listening on http://127.0.0.1:${handle.port}`);
console.log(`[sim] open http://127.0.0.1:${handle.port}/app`);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

do {
  if (LOOP) {
    // Reset to idle so each looped run starts from a clean connect.
    session = undefined;
    set = undefined;
    device = { connected: false };
    await sleep(4000);
  }
  await runWorkout().catch((err) => console.error('[sim] workout error', err));
} while (LOOP);

// Single-run: hold the server open at the final session state for observation.
console.log('[sim] holding server open — Ctrl-C to stop, or re-run with LOOP=1.');
