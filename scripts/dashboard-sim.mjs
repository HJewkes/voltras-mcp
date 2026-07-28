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
//   DUAL=1 node scripts/dashboard-sim.mjs       # two slots (left/right) for the
//                                               # diverging bilateral stage; open
//                                               # /app?live=1&variant=live-dual
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
// The live STAGE (as opposed to the rest/idle stages) only renders when the store's
// `live` slice is populated, and that slice is fed by the SSE hub — not by the
// snapshot. Without a hub the sim could drive the whole workout and never once show
// the thing the live page exists for.
const { LiveSignalHub } = await import(path.resolve(__dirname, '../dist/state/live-signal.js'));

const PORT = Number(process.env.PORT ?? 7799);
const LOOP = process.env.LOOP === '1';
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mutable live state the dashboard reads ────────────────────────────────
//
// DUAL=1 drives TWO slots (`left` / `right`) instead of one `primary`, which is what
// the diverging bilateral stage reads (`devices[].slotId`, VW-71 / VMCP-04.05). Until
// this existed the dual path could not be exercised without two real Voltras, so it
// had never been rendered at all. The right arm is scripted to fatigue FASTER so the
// L/R asymmetry callout has something honest to report.
const DUAL = process.env.DUAL === '1';
/** Slot ids in the shape the snapshot builder keys `devices[].slotId` by. */
const SLOT_IDS = DUAL ? ['left', 'right'] : ['primary'];
/** Extra per-rep velocity decay on the right arm, as a fraction of the left's. */
const RIGHT_FATIGUE_BIAS = 1.7;

let device = { connected: false };
let session; // ActiveSession | undefined
/** Active set PER SLOT — the single-slot case just has one entry. */
const sets = new Map(SLOT_IDS.map((id) => [id, undefined]));

const liveSignals = new LiveSignalHub();

const state = {
  liveSignals,
  slots: new Map(
    SLOT_IDS.map((id) => [
      id,
      {
        live: {
          snapshotDevice: () => device,
          // Only the first slot reports the session — the snapshot builder takes the
          // first one it finds, and a second copy would just be discarded.
          snapshotSession: () => (id === SLOT_IDS[0] ? session : undefined),
          snapshotSet: () => sets.get(id),
        },
      },
    ]),
  ),
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
/**
 * One rep in the shape the SPA actually reads.
 *
 * `peakVelocity` alone is NOT enough: every live velocity read-out is MEAN-based
 * (VW-58), and WA derives the mean from `_totalVelocity / _movementSampleCount`.
 * A rep without those fields yields a null mean, so the velocity strips render
 * EMPTY while everything else on the page looks fine — which is exactly how the
 * diverging stage first came up blank. The mean is set a little under the peak,
 * the way a real rep's average sits below its peak.
 */
const makeRep = (peakMms) => {
  const meanMms = Math.round(peakMms * 0.82);
  return {
    repNumber: ++repSeq,
    concentric: {
      peakVelocity: peakMms, // mm/s; SPA renders m/s
      _totalVelocity: meanMms,
      _movementSampleCount: 1,
    },
    eccentric: {},
  };
};

/**
 * Push one slot's per-sample frames + finalized rep onto the live hub.
 *
 * The snapshot alone is not enough: `mapStoreToDashboardModel` returns a null `live`
 * layer unless the SSE slice is populated, so a snapshot-only sim always renders the
 * REST/idle stage. Frames are coarse (a handful per rep, not the real ~11 Hz) — this
 * exists to reach the stage and check its layout and per-limb wiring, not to imitate
 * the sample cadence.
 */
function emitRep(slotId, repIndex, peakMms) {
  const now = Date.now();
  const phases = [
    ['ecc', 300],
    ['hold', 120],
    ['con', 420],
  ];
  let t = now;
  for (const [phase, dur] of phases) {
    liveSignals.emit({
      type: 'phaseflip',
      data: { slot: slotId, t, from: 'idle', to: phase, repIndex },
    });
    liveSignals.emit({
      type: 'phase',
      data: {
        slot: slotId,
        t,
        phase,
        phaseElapsedMs: dur,
        position: phase === 'con' ? 480 : 120,
        velocity: phase === 'con' ? peakMms / 1000 : -(peakMms / 1400),
        force: 92,
        repInProgress: repIndex,
      },
    });
    t += dur;
  }
  liveSignals.emit({
    type: 'rep',
    data: {
      slot: slotId,
      repIndex,
      meanConcentricVelocity: peakMms / 1000,
      peakConcentricVelocity: peakMms / 1000,
    },
  });
}

/**
 * Announce a set arming/closing on the live hub.
 *
 * Without these the `live` slice never clears: the SPA keeps the last set's live
 * anchor on screen through the rest period, so the stage stays "live" with an empty
 * velocity strip instead of falling through to the rest recap. Real MCP emits these
 * from the set lifecycle; a sim that skipped them was quietly misrepresenting the
 * one transition the live page cares most about.
 */
function emitSet(slotId, kind, setId) {
  liveSignals.emit({
    type: 'set',
    data: { slot: slotId, kind, setId, sessionId: session.sessionId },
  });
}

/** Per-rep decay rate for a slot — the right arm tires faster, so L/R diverges. */
function decayFor(slotId) {
  return slotId === 'right' ? 0.06 * RIGHT_FATIGUE_BIAS : 0.06;
}

async function runSet({ setNumber, weightLbs, repCount, startPeak, restMs }) {
  console.log(`[sim] set ${setNumber} — ${weightLbs} lb, ${repCount} reps${DUAL ? ' (dual)' : ''}`);
  device = { connected: true, weightLbs, trainingMode: 'WeightTraining', batteryPercent: 88 };
  const setId = `sim-set-${setNumber}-${Date.now()}`;
  repSeq = 0;
  for (const id of SLOT_IDS) {
    sets.set(id, {
      setId: `${setId}-${id}`,
      sessionId: session.sessionId,
      startedAt: nowIso(),
      reps: [],
      status: 'active',
    });
    emitSet(id, 'started', `${setId}-${id}`);
  }

  // Reps land ~1.5s apart with velocity decaying across the set (fatigue). Both arms
  // land a rep together — close enough to reality for a layout/telemetry check, and it
  // keeps the two wings index-locked the way the component expects.
  for (let i = 0; i < repCount; i++) {
    await sleep(1500);
    for (const id of SLOT_IDS) {
      const peak = Math.round(startPeak - i * (startPeak * decayFor(id)));
      const cur = sets.get(id);
      sets.set(id, { ...cur, reps: [...cur.reps, makeRep(peak)] });
      emitRep(id, i + 1, peak);
      console.log(`[sim]   ${id} rep ${i + 1}/${repCount} @ ${(peak / 1000).toFixed(2)} m/s`);
    }
  }

  // Close the set: mark ended, record it on the session, then drop to null so
  // the SPA's non-null→null transition logs the completed set into the table.
  for (const id of SLOT_IDS) {
    sets.set(id, { ...sets.get(id), status: 'ended', endedAt: nowIso() });
    emitSet(id, 'ended', `${setId}-${id}`);
  }
  session.setIds = [...session.setIds, setId];
  await sleep(800);
  for (const id of SLOT_IDS) sets.set(id, undefined);

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
    for (const id of SLOT_IDS) sets.set(id, undefined);
    device = { connected: false };
    await sleep(4000);
  }
  await runWorkout().catch((err) => console.error('[sim] workout error', err));
} while (LOOP);

// Single-run: hold the server open at the final session state for observation.
console.log('[sim] holding server open — Ctrl-C to stop, or re-run with LOOP=1.');
