// Unit tests for LiveState.
//
// Covers every branch in src/state/live-state.ts to satisfy NF-03 (≥80%
// branch coverage for src/state/). Tests are organized by mutator/snapshot
// pair plus a final group for cross-cutting invariants (independence of
// snapshots, stale-rep drop, null battery coercion).
import { describe, expect, it } from 'vitest';
import type { Rep, WorkoutSample } from '@voltras/workout-analytics';
import {
  LiveState,
  selectSetReps,
  firmwareEnrichedReps,
  type ActiveSession,
  type ActiveSet,
  type FirmwareRep,
} from '../live-state.js';

const TS_A = '2025-01-01T00:00:00.000Z';
const TS_B = '2025-01-01T00:01:00.000Z';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 'sess-1',
    startedAt: TS_A,
    setIds: [],
    status: 'active',
    ...overrides,
  };
}

function makeSet(overrides: Partial<ActiveSet> = {}): ActiveSet {
  return {
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: TS_A,
    reps: [],
    status: 'active',
    ...overrides,
  };
}

function makeRep(repNumber: number): Rep {
  // Construct a minimal Rep that satisfies the analytics interface for tests.
  // We rely on shape rather than runtime computation; LiveState never calls
  // analytics functions on these reps.
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 0,
    startPosition: 0,
    endPosition: 0,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return { repNumber, concentric: phase, eccentric: phase };
}

describe('LiveState', () => {
  describe('initial state', () => {
    it('has a disconnected device, no session, no set', () => {
      const live = new LiveState();
      expect(live.device).toEqual({ connected: false });
      expect(live.session).toBeUndefined();
      expect(live.set).toBeUndefined();
      expect(live.snapshotSession()).toBeUndefined();
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('startSession / endSession', () => {
    it('startSession sets the active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      const snap = live.snapshotSession();
      expect(snap?.sessionId).toBe('sess-1');
      expect(snap?.status).toBe('active');
    });

    it('startSession is a no-op when a session is already active', () => {
      // Documented behavior: tool layer enforces SESSION_ALREADY_ACTIVE
      // (EC-14); LiveState chooses silent no-op so mutators stay total.
      const live = new LiveState();
      live.startSession(makeSession({ sessionId: 'first' }));
      live.startSession(makeSession({ sessionId: 'second' }));
      expect(live.snapshotSession()?.sessionId).toBe('first');
    });

    it('endSession returns the prior session with status=ended', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      const ended = live.endSession();
      expect(ended?.sessionId).toBe('sess-1');
      expect(ended?.status).toBe('ended');
      expect(live.snapshotSession()).toBeUndefined();
    });

    it('endSession returns undefined when no session is active', () => {
      const live = new LiveState();
      expect(live.endSession()).toBeUndefined();
    });
  });

  describe('startSet / endSet', () => {
    it('startSet sets the active set', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      expect(live.snapshotSet()?.setId).toBe('set-1');
    });

    it('startSet is a no-op when a set is already active', () => {
      const live = new LiveState();
      live.startSet(makeSet({ setId: 'first' }));
      live.startSet(makeSet({ setId: 'second' }));
      expect(live.snapshotSet()?.setId).toBe('first');
    });

    it('startSet → appendRep × 3 → endSet captures the reps', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      live.appendRep(makeRep(2));
      live.appendRep(makeRep(3));
      const finalized = live.endSet();
      expect(finalized?.reps).toHaveLength(3);
      expect(finalized?.reps.map((r) => r.repNumber)).toEqual([1, 2, 3]);
      expect(finalized?.status).toBe('ended');
      expect(finalized?.partialReason).toBeUndefined();
      expect(finalized?.endedAt).toBeDefined();
      expect(live.snapshotSet()).toBeUndefined();
    });

    it("endSet('session_end') marks set partial with partialReason='session_end'", () => {
      const live = new LiveState();
      live.startSet(makeSet());
      const finalized = live.endSet('session_end');
      expect(finalized?.status).toBe('partial');
      expect(finalized?.partialReason).toBe('session_end');
    });

    it("endSet('disconnect') marks set partial with partialReason='disconnect'", () => {
      const live = new LiveState();
      live.startSet(makeSet());
      const finalized = live.endSet('disconnect');
      expect(finalized?.status).toBe('partial');
      expect(finalized?.partialReason).toBe('disconnect');
    });

    it('endSet returns undefined when no set is active', () => {
      const live = new LiveState();
      expect(live.endSet()).toBeUndefined();
      expect(live.endSet('disconnect')).toBeUndefined();
    });

    it('endSet appends the setId to the active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()?.setIds).toEqual(['set-1']);
    });

    it('endSet does not duplicate an already-tracked setId', () => {
      const live = new LiveState();
      live.startSession(makeSession({ setIds: ['set-1'] }));
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()?.setIds).toEqual(['set-1']);
    });

    it('endSet without an active session leaves session state untouched', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()).toBeUndefined();
    });
  });

  describe('endSet — dropTrailingInProgress (F14 / VMCP-01.28)', () => {
    // Phase enum values from @voltras/workout-analytics:
    //   1 = CONCENTRIC, 3 = ECCENTRIC. Building samples by literal so the
    //   test stays decoupled from internal enum-value drift in the analytics
    //   package; the contract is the integer wire value the SDK emits.
    const CONCENTRIC = 1;
    const ECCENTRIC = 3;

    function sample(seq: number, phase: number, velocity: number): WorkoutSample {
      return {
        sequence: seq,
        timestamp: 1000 + seq * 50,
        phase: phase as WorkoutSample['phase'],
        position: seq * 0.01,
        velocity,
        force: 50,
      };
    }

    /**
     * Drive N complete rep cycles (each: 1 concentric + 1 eccentric frame)
     * then `extraConcentricSamples` extra concentric samples after the last
     * eccentric — simulating the in-progress next rep that the bridge has
     * appended at index N when the watch trigger fires.
     */
    function driveSamples(
      live: LiveState,
      completeReps: number,
      extraConcentricSamples: number,
      velocity: number,
    ): number {
      let seq = 0;
      for (let i = 0; i < completeReps; i++) {
        live.processSample(sample(seq++, CONCENTRIC, velocity));
        live.processSample(sample(seq++, ECCENTRIC, velocity));
      }
      for (let i = 0; i < extraConcentricSamples; i++) {
        live.processSample(sample(seq++, CONCENTRIC, velocity));
      }
      return seq;
    }

    it('drops the trailing in-progress rep when called with dropTrailingInProgress', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      // 5 complete cycles + the next concentric sample → analytics-set has
      // 6 reps where reps[5] has concentric samples only (eccentric empty).
      driveSamples(live, 5, 1, 0.6);
      // Sanity: pre-finalize the analytics path reflects the in-progress rep.
      expect(live.snapshotSet()?.reps.length).toBe(6);

      const finalized = live.endSet('inactivity_timeout', { dropTrailingInProgress: true });
      expect(finalized).toBeDefined();
      expect(finalized?.reps.length).toBe(5);
      // Every persisted rep has an eccentric phase (real, completed rep).
      for (const rep of finalized!.reps) {
        expect(rep.eccentric.samples.length).toBeGreaterThan(0);
      }
      // Status + partialReason still threaded correctly.
      expect(finalized?.status).toBe('partial');
      expect(finalized?.partialReason).toBe('inactivity_timeout');
    });

    it('preserves the trailing rep on graceful endSet (no drop flag) — F7 regression guard', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      driveSamples(live, 5, 1, 0.6);
      // Graceful tool path: no reason, no drop flag.
      const finalized = live.endSet();
      expect(finalized).toBeDefined();
      // Trailing in-progress rep stays — F7 deferred work, the graceful
      // path's behavior is intentionally unchanged.
      expect(finalized?.reps.length).toBe(6);
      expect(finalized?.reps[5].eccentric.samples.length).toBe(0);
      expect(finalized?.status).toBe('ended');
    });

    it('leaves a complete trailing rep alone even when dropTrailingInProgress is set', () => {
      // The inactivity watchdog can fire *after* the user finishes a rep
      // cycle (eccentric closed) but before they start the next rep. The
      // trailing rep is the just-completed rep N with eccentric samples.
      // The predicate must not drop it.
      const live = new LiveState();
      live.startSet(makeSet());
      driveSamples(live, 3, 0, 0.6);
      const before = live.snapshotSet()?.reps.length ?? 0;
      const finalized = live.endSet('inactivity_timeout', { dropTrailingInProgress: true });
      expect(finalized?.reps.length).toBe(before);
    });

    it('is a no-op on an empty rep array', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      const finalized = live.endSet('inactivity_timeout', { dropTrailingInProgress: true });
      expect(finalized?.reps.length).toBe(0);
    });
  });

  describe('firmware-rep finalize + trailing drop (VMCP-02.29 PR4)', () => {
    // An enriched VBT rep whose eccentric phase is complete (has samples) vs
    // in-progress (empty). `isTrailingFirmwareRepIncomplete` mirrors the
    // analytics rule: eccentric.samples.length === 0 ⇒ in-progress.
    function enrichedRep(repNumber: number, eccentricComplete: boolean): Rep {
      const base = makeRep(repNumber);
      if (!eccentricComplete) {
        return base; // makeRep's eccentric.samples is already []
      }
      const eccSample: WorkoutSample = {
        sequence: 0,
        timestamp: 0,
        phase: 3 as WorkoutSample['phase'],
        position: 0,
        velocity: 0,
        force: 0,
      };
      return { ...base, eccentric: { ...base.eccentric, samples: [eccSample] } };
    }

    function firmwareRep(repNumber: number, eccentricComplete: boolean): FirmwareRep {
      return {
        ts: repNumber,
        repNumber,
        setCounter: 1,
        frameCounter: repNumber,
        targetWeightTenths: 0,
        enriched: enrichedRep(repNumber, eccentricComplete),
      };
    }

    it('finalizeFirmwareReps appends the terminal rep and records the total count', () => {
      const live = new LiveState();
      live.startSet(makeSet({ firmwareReps: [firmwareRep(1, true)] }));
      live.finalizeFirmwareReps(firmwareRep(2, true), 2);
      const set = live.snapshotSet();
      expect(set?.firmwareReps).toHaveLength(2);
      expect(set?.firmwareReps?.[1].repNumber).toBe(2);
      expect(set?.firmwareTotalRepCount).toBe(2);
    });

    it('trusts the device count verbatim and does NOT synthesize a phantom terminal rep when boundaries already cover it (VMCP-02.75 over-count regression)', () => {
      // Bench 2026-07-07 WT set ab482e3f: 8 clean reps, every rep (including the
      // last) fired its `onPerRep` 'return', so all 8 boundaries are in
      // `firmwareReps` and the device's `onSetSummary` repCount = 8. The old
      // `max(existing+1, device)` reconstruction appended a positional 9th rep
      // and reported 9 — the "bridge inflated to 9" over-count. Firmware-canonical
      // takes the device count verbatim (8) and appends nothing.
      const live = new LiveState();
      live.startSet(
        makeSet({
          firmwareReps: Array.from({ length: 8 }, (_, i) => firmwareRep(i + 1, true)),
        }),
      );
      live.finalizeFirmwareReps(firmwareRep(99, true), 8);
      const set = live.snapshotSet();
      expect(set?.firmwareReps).toHaveLength(8);
      expect(set?.firmwareTotalRepCount).toBe(8);
    });

    it('materializes the terminal enriched slice only when the device counted a rep with no captured boundary', () => {
      // The device counted a rep we have no `onPerRep` boundary for (the final
      // 'return' never fired): `existing.length (1) < deviceReportedTotal (2)`.
      // The terminal slice fills the enrichment gap without exceeding the
      // authoritative device count.
      const live = new LiveState();
      live.startSet(makeSet({ firmwareReps: [firmwareRep(1, true)] }));
      // finalRep carries a deliberately-wrong repNumber (99) to prove the
      // appended slice's number is derived positionally, not trusted from input.
      live.finalizeFirmwareReps(firmwareRep(99, true), 2);
      const set = live.snapshotSet();
      expect(set?.firmwareReps).toHaveLength(2);
      expect(set?.firmwareReps?.[1].repNumber).toBe(2);
      expect(set?.firmwareTotalRepCount).toBe(2);
    });

    it('finalizeFirmwareReps is a silent no-op when no set is active', () => {
      const live = new LiveState();
      live.finalizeFirmwareReps(firmwareRep(1, true), 1);
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('drops the trailing in-progress firmware rep on inactivity force-close', () => {
      const live = new LiveState();
      live.startSet(makeSet({ firmwareReps: [firmwareRep(1, true), firmwareRep(2, false)] }));
      const finalized = live.endSet('inactivity_timeout', { dropTrailingInProgress: true });
      expect(finalized?.firmwareReps).toHaveLength(1);
      expect(finalized?.firmwareReps?.[0].repNumber).toBe(1);
      expect(finalized?.partialReason).toBe('inactivity_timeout');
    });

    it('keeps a complete trailing firmware rep even when dropTrailingInProgress is set', () => {
      const live = new LiveState();
      live.startSet(makeSet({ firmwareReps: [firmwareRep(1, true), firmwareRep(2, true)] }));
      const finalized = live.endSet('inactivity_timeout', { dropTrailingInProgress: true });
      expect(finalized?.firmwareReps).toHaveLength(2);
    });

    it('preserves the trailing firmware rep on a graceful close (no drop flag)', () => {
      const live = new LiveState();
      live.startSet(makeSet({ firmwareReps: [firmwareRep(1, true), firmwareRep(2, false)] }));
      const finalized = live.endSet();
      expect(finalized?.firmwareReps).toHaveLength(2);
      expect(finalized?.status).toBe('ended');
    });
  });

  describe('selectSetReps — REP_SOURCE read boundary (VMCP-02.29 PR5)', () => {
    function fw(repNumber: number): FirmwareRep {
      return {
        ts: repNumber,
        repNumber,
        setCounter: 1,
        frameCounter: repNumber,
        targetWeightTenths: 0,
        enriched: makeRep(repNumber),
      };
    }

    const seeded = makeSet({
      reps: [makeRep(1), makeRep(2), makeRep(3)],
      firmwareReps: [fw(900), fw(901)],
      firmwareTotalRepCount: 2,
    });

    it("'analytics' returns the SAME set reference unchanged (byte-identical)", () => {
      const out = selectSetReps(seeded, 'analytics');
      expect(out).toBe(seeded);
      expect(out.reps.map((r) => r.repNumber)).toEqual([1, 2, 3]);
    });

    it('an unset/undefined source defaults to analytics (dark-flag safety)', () => {
      const out = selectSetReps(seeded, undefined);
      expect(out).toBe(seeded);
      expect(out.reps.map((r) => r.repNumber)).toEqual([1, 2, 3]);
    });

    it("'firmware' swaps reps for the enriched firmware reps, preserving other fields", () => {
      const out = selectSetReps(seeded, 'firmware');
      expect(out).not.toBe(seeded);
      expect(out.reps.map((r) => r.repNumber)).toEqual([900, 901]);
      // firmwareTotalRepCount (and every non-reps field) is carried through.
      expect(out.firmwareTotalRepCount).toBe(2);
      expect(out.setId).toBe(seeded.setId);
    });

    it('firmwareEnrichedReps falls back to an empty rep for an un-enriched boundary', () => {
      const bare: FirmwareRep = {
        ts: 1,
        repNumber: 5,
        setCounter: 1,
        frameCounter: 5,
        targetWeightTenths: 0,
      };
      const reps = firmwareEnrichedReps(makeSet({ firmwareReps: [bare] }));
      expect(reps).toHaveLength(1);
      expect(reps[0]).toBeDefined();
    });

    it('firmwareEnrichedReps returns [] when the set has no firmware reps', () => {
      expect(firmwareEnrichedReps(makeSet())).toEqual([]);
    });
  });

  describe('appendRep edge cases (EC-11)', () => {
    it('appendRep before startSet is silently dropped', () => {
      const live = new LiveState();
      live.appendRep(makeRep(1));
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('appendRep after endSet is silently dropped (no callback fired)', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      const finalized = live.endSet();
      expect(finalized?.reps).toHaveLength(1);
      // Stale rep arrives after endSet — must not mutate any visible state.
      live.appendRep(makeRep(2));
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('markDisconnected', () => {
    it('sets disconnectedAt on device only when no session is active', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, weightLbs: 80 });
      live.markDisconnected(TS_B);
      expect(live.snapshotDevice()).toMatchObject({
        connected: false,
        disconnectedAt: TS_B,
        staleSinceDisconnect: TS_B,
        isStale: true,
      });
      expect(live.snapshotSession()).toBeUndefined();
    });

    it('propagates disconnectedAt to an active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      live.markDisconnected(TS_B);
      expect(live.snapshotSession()?.disconnectedAt).toBe(TS_B);
      expect(live.snapshotDevice().disconnectedAt).toBe(TS_B);
    });
  });

  describe('soft-reset staleness (Phase 0.5.1)', () => {
    it('preserves last-known device settings after markDisconnected', () => {
      const live = new LiveState();
      live.applySettings({
        connected: true,
        weightLbs: 100,
        trainingMode: 'WeightTraining',
        damperLevel: 3,
      });
      live.markDisconnected(TS_B);
      const snap = live.snapshotDevice();
      expect(snap.weightLbs).toBe(100);
      expect(snap.trainingMode).toBe('WeightTraining');
      expect(snap.damperLevel).toBe(3);
      expect(snap.connected).toBe(false);
      expect(snap.staleSinceDisconnect).toBe(TS_B);
      expect(snap.isStale).toBe(true);
      expect(live.isStale()).toBe(true);
    });

    it('clearStaleness drops the flag and the snapshot loses staleness fields', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, weightLbs: 80 });
      live.markDisconnected(TS_B);
      expect(live.isStale()).toBe(true);
      live.clearStaleness();
      expect(live.isStale()).toBe(false);
      const snap = live.snapshotDevice();
      expect(snap.staleSinceDisconnect).toBeUndefined();
      expect(snap.isStale).toBeUndefined();
      expect(snap.weightLbs).toBe(80);
    });

    it('isStale starts false on a fresh LiveState', () => {
      const live = new LiveState();
      expect(live.isStale()).toBe(false);
      expect(live.snapshotDevice().staleSinceDisconnect).toBeUndefined();
    });
  });

  describe('applySettings', () => {
    it('coerces battery null → absent (critic FIX #6)', () => {
      const live = new LiveState();
      live.applySettings({
        connected: true,
        // Cast required: SDK runtime can deliver null even though our
        // typed surface forbids it.
        batteryPercent: null as unknown as number,
      });
      const snap = live.snapshotDevice();
      expect(snap.batteryPercent).toBeUndefined();
      expect('batteryPercent' in snap).toBe(false);
    });

    it('passes a real numeric battery value through', () => {
      const live = new LiveState();
      live.applySettings({ batteryPercent: 73 });
      expect(live.snapshotDevice().batteryPercent).toBe(73);
    });

    it('drops a previously-set battery when later update reports null', () => {
      const live = new LiveState();
      live.applySettings({ batteryPercent: 50 });
      live.applySettings({
        batteryPercent: null as unknown as number,
      });
      expect(live.snapshotDevice().batteryPercent).toBeUndefined();
    });

    it('merges multiple partial updates additively', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, batteryPercent: 90 });
      live.applySettings({ weightLbs: 100, trainingMode: 'WeightTraining' });
      expect(live.snapshotDevice()).toEqual({
        connected: true,
        batteryPercent: 90,
        weightLbs: 100,
        trainingMode: 'WeightTraining',
      });
    });

    it('C5 — stores and exposes damperLevel via snapshotDevice', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, damperLevel: 5 });
      expect(live.snapshotDevice().damperLevel).toBe(5);
    });

    it('C5 — damperLevel is absent from snapshot when never set', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, weightLbs: 80 });
      expect(live.snapshotDevice().damperLevel).toBeUndefined();
    });
  });

  describe('applyInProgress (typed-payload live-state plumbing)', () => {
    const payload = {
      peakForceTenths: 1234,
      currentForceTenths: 800,
      velocityCmPerSec: 45,
      targetWeightTenths: 1350,
      raw: new Uint8Array(79),
    };

    it('is a no-op when no set is active', () => {
      const live = new LiveState();
      live.applyInProgress(payload, 1_000);
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('captures the latest payload on the active set', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applyInProgress(payload, 1_700_000_000_000);
      expect(live.snapshotSet()?.latestInProgress).toEqual({
        peakForceTenths: 1234,
        currentForceTenths: 800,
        velocityCmPerSec: 45,
        targetWeightTenths: 1350,
        capturedAt: 1_700_000_000_000,
      });
    });

    it('overwrites — later payloads replace earlier ones rather than accumulating', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applyInProgress(payload, 1_000);
      live.applyInProgress(
        {
          peakForceTenths: 9999,
          currentForceTenths: 7777,
          velocityCmPerSec: 88,
          targetWeightTenths: 2000,
          raw: new Uint8Array(79),
        },
        2_000,
      );
      expect(live.snapshotSet()?.latestInProgress).toEqual({
        peakForceTenths: 9999,
        currentForceTenths: 7777,
        velocityCmPerSec: 88,
        targetWeightTenths: 2000,
        capturedAt: 2_000,
      });
    });

    it('latestInProgress is dropped when endSet clears the active set', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applyInProgress(payload, 1_000);
      live.endSet();
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('applySummary / consumeLatestSummary (typed-payload live-state plumbing)', () => {
    const summaryPayload = {
      schemaVersion: 1,
      setCounter: 3,
      repCount: 8,
      raw: new Uint8Array(140),
    };

    it('applySummary is a no-op when no set is active', () => {
      const live = new LiveState();
      live.applySummary(summaryPayload);
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('applySummary captures repCount + schemaVersion on the active set', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applySummary(summaryPayload);
      expect(live.snapshotSet()?.latestSummary).toEqual({
        repCount: 8,
        schemaVersion: 1,
      });
    });

    it('consumeLatestSummary returns undefined when no set is active', () => {
      const live = new LiveState();
      expect(live.consumeLatestSummary()).toBeUndefined();
    });

    it('consumeLatestSummary returns undefined when active set has no summary', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      expect(live.consumeLatestSummary()).toBeUndefined();
    });

    it('consumeLatestSummary read-and-clears the active set summary', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applySummary(summaryPayload);
      const consumed = live.consumeLatestSummary();
      expect(consumed).toEqual({ repCount: 8, schemaVersion: 1 });
      // Subsequent reads see nothing — strictly read-once semantics.
      expect(live.consumeLatestSummary()).toBeUndefined();
      expect(live.snapshotSet()?.latestSummary).toBeUndefined();
    });

    it('latestSummary is dropped when endSet clears the active set (mid-set disconnect path)', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.applySummary(summaryPayload);
      live.endSet('disconnect');
      // No active set to consume from anymore — guards against stale carry-forward.
      expect(live.snapshotSet()).toBeUndefined();
      expect(live.consumeLatestSummary()).toBeUndefined();
    });
  });

  describe('snapshot independence', () => {
    it('snapshotDevice returns an independent copy', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, trainingMode: 'WeightTraining' });
      const snap = live.snapshotDevice();
      snap.trainingMode = 'mutated';
      expect(live.snapshotDevice().trainingMode).toBe('WeightTraining');
    });

    it('snapshotSession returns an independent copy with cloned setIds', () => {
      const live = new LiveState();
      live.startSession(makeSession({ setIds: ['s1'] }));
      const snap = live.snapshotSession();
      expect(snap).toBeDefined();
      snap!.setIds.push('mutated');
      snap!.exerciseId = 'x';
      expect(live.snapshotSession()?.setIds).toEqual(['s1']);
      expect(live.snapshotSession()?.exerciseId).toBeUndefined();
    });

    it('snapshotSet returns an independent copy with cloned reps', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      const snap = live.snapshotSet();
      expect(snap).toBeDefined();
      snap!.reps.push(makeRep(99));
      expect(live.snapshotSet()?.reps).toHaveLength(1);
    });
  });

  describe('applyStateDump', () => {
    it('merges assistMode + cmd=0x07 fields into device snapshot', () => {
      const live = new LiveState();
      live.applyStateDump({
        assistMode: 2,
        trainingModeRaw: 1,
        chainTargetForceTenths: 250,
        weightLbsTenths: 250,
        eccentricPercentTenths: 0,
      });
      const snap = live.snapshotDevice();
      expect(snap.assistMode).toBe(2);
      expect(snap.trainingModeRaw).toBe(1);
      expect(snap.chainTargetForceTenths).toBe(250);
      expect(snap.weightLbsTenths).toBe(250);
      expect(snap.eccentricPercentTenths).toBe(0);
    });

    it('does not clobber existing device fields (connected, weightLbs, etc.)', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, weightLbs: 100, batteryPercent: 80 });
      live.applyStateDump({
        assistMode: 0,
        trainingModeRaw: 1,
        chainTargetForceTenths: 0,
        weightLbsTenths: 1000,
        eccentricPercentTenths: 0,
      });
      const snap = live.snapshotDevice();
      expect(snap.connected).toBe(true);
      expect(snap.weightLbs).toBe(100);
      expect(snap.batteryPercent).toBe(80);
    });

    it('updates assistMode to idle sentinel (8) without clobbering prior state-dump values', () => {
      const live = new LiveState();
      live.applyStateDump({
        assistMode: 2,
        trainingModeRaw: 1,
        chainTargetForceTenths: 300,
        weightLbsTenths: 300,
        eccentricPercentTenths: 0,
      });
      live.applyStateDump({
        assistMode: 8,
        trainingModeRaw: 1,
        chainTargetForceTenths: 300,
        weightLbsTenths: 300,
        eccentricPercentTenths: 0,
      });
      const snap = live.snapshotDevice();
      expect(snap.assistMode).toBe(8);
      expect(snap.trainingModeRaw).toBe(1);
      expect(snap.chainTargetForceTenths).toBe(300);
    });

    it('overwrites prior state-dump values on subsequent calls', () => {
      const live = new LiveState();
      live.applyStateDump({
        assistMode: 2,
        trainingModeRaw: 1,
        chainTargetForceTenths: 100,
        weightLbsTenths: 100,
        eccentricPercentTenths: 0,
      });
      live.applyStateDump({
        assistMode: 0,
        trainingModeRaw: 2,
        chainTargetForceTenths: 200,
        weightLbsTenths: 200,
        eccentricPercentTenths: 50,
      });
      const snap = live.snapshotDevice();
      expect(snap.assistMode).toBe(0);
      expect(snap.trainingModeRaw).toBe(2);
      expect(snap.chainTargetForceTenths).toBe(200);
      expect(snap.weightLbsTenths).toBe(200);
      expect(snap.eccentricPercentTenths).toBe(50);
    });

    it('keeps chainSettingLbs (cmd=0x10 cascade source) distinct from state-dump fields', () => {
      // Settings cascade carries the user's post-cap chains setting; the
      // state-dump path is independent and updates separate fields.
      const live = new LiveState();
      live.applySettings({ chainSettingLbs: 50 });
      live.applyStateDump({
        assistMode: 0,
        trainingModeRaw: 1,
        chainTargetForceTenths: 500,
        weightLbsTenths: 500,
        eccentricPercentTenths: 0,
      });
      const snap = live.snapshotDevice();
      expect(snap.chainSettingLbs).toBe(50);
      // chainTargetForceTenths is the on-cable effective chain force.
      expect(snap.chainTargetForceTenths).toBe(500);
      expect(snap.trainingModeRaw).toBe(1);
    });
  });
});
