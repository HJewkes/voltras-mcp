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
//                                               # /app?live=1
//   TRANSITIONS=1 node scripts/dashboard-sim.mjs # binds a second Voltra mid-set, then
//                                               # drops it — exercises the state-driven
//                                               # single↔dual swap (VMCP-04.07)
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
// TRANSITIONS=1 scripts the two moments the page's stage selection exists for (VMCP-04.07):
// a second Voltra BINDING mid-set (single → dual) and one DROPPING mid-set (dual → single).
// Neither is expressible with a fixed slot set, which is why `state.slots` below is mutated
// at runtime rather than built once — the snapshot builder re-reads it on every request, so
// a bind/release lands on the very next poll exactly as a real one would.
const TRANSITIONS = process.env.TRANSITIONS === '1';
/** Slot ids in the shape the snapshot builder keys `devices[].slotId` by. */
const SLOT_IDS = DUAL || TRANSITIONS ? ['left', 'right'] : ['primary'];
/** Slots bound at boot. The transition script starts one-armed and binds the second later. */
const INITIAL_SLOT_IDS = TRANSITIONS ? ['left'] : SLOT_IDS;
/** Extra per-rep velocity decay on the right arm, as a fraction of the left's. */
const RIGHT_FATIGUE_BIAS = 1.7;

let session; // ActiveSession | undefined
/** Device snapshot PER SLOT, so one limb can drop while the other keeps lifting. */
const devices = new Map(SLOT_IDS.map((id) => [id, { connected: false }]));
/** Active set PER SLOT — the single-slot case just has one entry. */
const sets = new Map(SLOT_IDS.map((id) => [id, undefined]));

const liveSignals = new LiveSignalHub();

/** The live-state facade one slot presents to the snapshot builder. */
const slotFacade = (id) => ({
  live: {
    snapshotDevice: () => devices.get(id),
    // Only the FIRST bound slot reports the session — the snapshot builder takes the first
    // one it finds, and a second copy would just be discarded. Computed rather than pinned
    // to `SLOT_IDS[0]` so releasing that slot hands the session to the survivor.
    snapshotSession: () => (id === [...state.slots.keys()][0] ? session : undefined),
    snapshotSet: () => sets.get(id),
  },
});

const state = {
  liveSignals,
  slots: new Map(INITIAL_SLOT_IDS.map((id) => [id, slotFacade(id)])),
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
const makeRep = (peakMms, romMm = 620) => {
  const meanMms = Math.round(peakMms * 0.82);
  // A half-sine velocity profile over the phase — enough shape for the ghost-spark to
  // draw a curve rather than a flat line, and for the grind signature to be non-trivial.
  //
  // `startMs` is NOT optional in practice: `buildVelocityCurve` concatenates the
  // concentric and eccentric streams and rebases every sample off the FIRST one's
  // timestamp, so two phases that both start at 0 overlay each other — the ghost-spark
  // draws the lowering back across the lift as a closed loop, and the ECC phase bar
  // spans the whole rep. A real device timestamps one monotonic timeline per rep.
  const stream = (phase, startMs, durationMs, peak, n = 12) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: startMs + Math.round((durationMs * i) / (n - 1)),
      velocity: Math.round(peak * Math.sin((Math.PI * (i + 0.5)) / n)),
      phase,
    }));
  const CONC_MS = 900;
  const PAUSE_MS = 150; // brief turnaround at the top, so the phases do not abut
  return {
    repNumber: ++repSeq,
    concentric: {
      peakVelocity: peakMms, // mm/s; SPA renders m/s
      _totalVelocity: meanMms,
      _movementSampleCount: 1,
      // ROM = |endPosition − startPosition| (WA `getPhaseRangeOfMotion`). Without these
      // the RomProgressionChart has no points and the fatigue card's middle section
      // renders BLANK while the velocity hero beside it looks perfectly healthy — the
      // same silent-empty failure the mean-velocity fields above exist to prevent.
      startPosition: 0,
      endPosition: romMm,
      samples: stream(1 /* CONCENTRIC */, 0, CONC_MS, peakMms),
    },
    // The ghost-spark draws concentric AND eccentric; an empty eccentric halves every
    // curve. The lowering is slower than the lift, as a real tempo is, and it starts
    // where the concentric ended — see the `startMs` note above.
    eccentric: {
      startPosition: romMm,
      endPosition: 0,
      samples: stream(3 /* ECCENTRIC */, CONC_MS + PAUSE_MS, 1400, Math.round(peakMms * 0.7)),
    },
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

/** The slots the snapshot is currently reporting — re-read every rep, since it changes. */
const boundSlots = () => [...state.slots.keys()];

/**
 * Bind a Voltra to `slotId` mid-workout, joining any set already in progress.
 *
 * A slot that binds mid-set starts its own set from rep zero rather than inheriting the
 * other limb's reps — that is what a second Voltra actually reports, and it is what makes
 * the diverging stage's two wings honestly unequal at the moment of the swap.
 */
function bindSlot(slotId, { weightLbs, setId }) {
  devices.set(slotId, {
    connected: true,
    weightLbs,
    trainingMode: 'WeightTraining',
    batteryPercent: 84,
  });
  if (setId !== undefined) {
    sets.set(slotId, {
      setId: `${setId}-${slotId}`,
      sessionId: session.sessionId,
      startedAt: nowIso(),
      reps: [],
      status: 'active',
    });
  }
  state.slots.set(slotId, slotFacade(slotId));
  if (setId !== undefined) emitSet(slotId, 'started', `${setId}-${slotId}`);
  console.log(`[sim]   *** ${slotId} BOUND — expect the page to swap to the DUAL stage`);
}

/**
 * A limb's Voltra drops mid-set. The slot stays bound (a BLE drop is not a release), so
 * this is the harder of the two drop shapes for the page: the entry is still in
 * `devices[]` carrying its last-known reps, and only `connected: false` says it is gone.
 */
function dropSlot(slotId) {
  devices.set(slotId, { ...devices.get(slotId), connected: false, disconnectedAt: nowIso() });
  console.log(`[sim]   *** ${slotId} DROPPED — expect the page to fall back to the SINGLE stage`);
}

async function runSet({ setNumber, weightLbs, repCount, startPeak, restMs, bindAt, dropAt }) {
  console.log(`[sim] set ${setNumber} — ${weightLbs} lb, ${repCount} reps${DUAL ? ' (dual)' : ''}`);
  for (const id of boundSlots()) {
    devices.set(id, {
      connected: true,
      weightLbs,
      trainingMode: 'WeightTraining',
      batteryPercent: 88,
    });
  }
  const setId = `sim-set-${setNumber}-${Date.now()}`;
  repSeq = 0;
  for (const id of boundSlots()) {
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
    // Slot lifecycle mid-set (TRANSITIONS=1), applied BEFORE this rep so the swap and the
    // telemetry that justifies it land together.
    if (bindAt === i) bindSlot('right', { weightLbs, setId });
    if (dropAt === i) dropSlot('right');
    for (const id of boundSlots()) {
      // A dropped limb reports nothing further; its last-known reps stay on the snapshot.
      if (devices.get(id).connected === false) continue;
      const peak = Math.round(startPeak - i * (startPeak * decayFor(id)));
      // ROM shortens as the set fatigues (the "reps getting shorter" read the ROM chart
      // exists to show), floored so it degrades rather than collapsing to nothing.
      const romMm = Math.max(400, Math.round(620 - i * 22));
      const cur = sets.get(id);
      sets.set(id, { ...cur, reps: [...cur.reps, makeRep(peak, romMm)] });
      emitRep(id, i + 1, peak);
      console.log(`[sim]   ${id} rep ${i + 1}/${repCount} @ ${(peak / 1000).toFixed(2)} m/s`);
    }
  }

  // Close the set: mark ended, record it on the session, then drop to null so
  // the SPA's non-null→null transition logs the completed set into the table.
  for (const id of boundSlots()) {
    sets.set(id, { ...sets.get(id), status: 'ended', endedAt: nowIso() });
    emitSet(id, 'ended', `${setId}-${id}`);
  }
  session.setIds = [...session.setIds, setId];
  await sleep(800);
  for (const id of boundSlots()) sets.set(id, undefined);

  console.log(`[sim]   rest ${(restMs / 1000).toFixed(0)}s`);
  await sleep(restMs);
}

async function runWorkout() {
  await sleep(1500);
  console.log('[sim] device connecting…');
  for (const id of boundSlots()) {
    devices.set(id, {
      connected: true,
      weightLbs: 0,
      trainingMode: 'WeightTraining',
      batteryPercent: 90,
    });
  }
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

  // TRANSITIONS=1 runs longer sets so each steady state is on screen either side of the
  // swap: set 2 binds the second Voltra at rep 4 (single → dual), set 3 drops it at rep 4
  // (dual → single). Both happen MID-SET, which is the case that matters — an athlete is
  // lifting through them, so a blank frame would be a blank frame during a working set.
  const sets = TRANSITIONS
    ? [
        { setNumber: 1, weightLbs: 135, repCount: 5, startPeak: 820, restMs: 6000 },
        { setNumber: 2, weightLbs: 145, repCount: 9, startPeak: 760, restMs: 6000, bindAt: 4 },
        { setNumber: 3, weightLbs: 155, repCount: 9, startPeak: 690, restMs: 6000, dropAt: 4 },
      ]
    : [
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
console.log(`[sim] live page: http://127.0.0.1:${handle.port}/app?live=1 (stage picks itself)`);

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
    for (const id of SLOT_IDS) {
      sets.set(id, undefined);
      devices.set(id, { connected: false });
    }
    // Re-arm the slot script: the transition run must start one-armed again.
    state.slots = new Map(INITIAL_SLOT_IDS.map((id) => [id, slotFacade(id)]));
    await sleep(4000);
  }
  await runWorkout().catch((err) => console.error('[sim] workout error', err));
} while (LOOP);

// Single-run: hold the server open at the final session state for observation.
console.log('[sim] holding server open — Ctrl-C to stop, or re-run with LOOP=1.');
