/**
 * Round-trip codec tests — the 7 assertion groups from session-core-roundtrip-spec.md.
 *
 * Proves the canonical `WorkoutSession` model is a faithful, well-defined middle for both
 * platform stored shapes, and that the three lossy directions behave exactly as designed.
 */

import { describe, expect, it } from 'vitest';
import { mcpCodec, detectMcpLossyLoad } from '../mcp-codec.js';
import { mobileCodec, canonicalSetToMobileReps } from '../mobile-codec.js';
import { makeMcpFixture, makeMobileFixture, repSampleData } from './fixtures.js';

describe('1. core equivalence — both adapters produce the same canonical core', () => {
  it('agrees on sample-level analytics, index, load.weight, timestamps, status, ids, rep count', () => {
    const mcp = mcpCodec.toCanonical(makeMcpFixture());
    const mobile = mobileCodec.toCanonical(makeMobileFixture());

    const mcpSet = mcp.sets[0]!;
    const mobileSet = mobile.sets[0]!;

    // per-sample data identical (WA pre-normalizes units; replay preserves samples verbatim)
    expect(repSampleData(mcpSet.analytics)).toEqual(repSampleData(mobileSet.analytics));

    expect(mcpSet.index).toBe(0);
    expect(mobileSet.index).toBe(0);
    expect(mcpSet.load.weight).toBe(60);
    expect(mobileSet.load.weight).toBe(60);
    expect(mcpSet.analytics.reps).toHaveLength(2);
    expect(mobileSet.analytics.reps).toHaveLength(2);

    expect(mcp.status).toBe('completed');
    expect(mobile.status).toBe('completed');
    expect(mcp.exerciseId).toBe('cable-row');
    expect(mobile.exerciseId).toBe('cable-row');

    // timestamps in EpochMs on both sides
    expect(typeof mcp.startedAt).toBe('number');
    expect(mobileSet.startedAt).toBe(1752336005000);
    expect(mobileSet.endedAt).toBe(1752336040000);
  });
});

describe('2. idempotent round-trip (same platform)', () => {
  it('MCP: fromCanonical(toCanonical(B)) deepEquals B', () => {
    const b = makeMcpFixture();
    expect(mcpCodec.fromCanonical(mcpCodec.toCanonical(b))).toEqual(b);
  });

  it('mobile: fromCanonical(toCanonical(A)) deepEquals A', () => {
    const a = makeMobileFixture();
    expect(mobileCodec.fromCanonical(mobileCodec.toCanonical(a))).toEqual(a);
  });
});

describe('3. lossy — chains/eccentric (MCP-lossy)', () => {
  it('mobile canonical carries chains/ecc; MCP write drops them and the codec flags it', () => {
    const mobileCanonical = mobileCodec.toCanonical(makeMobileFixture());
    expect(mobileCanonical.sets[0]!.load).toEqual({ weight: 60, chains: 15, eccentric: 20 });

    // the codec surfaces exactly the fields an MCP write would silently lose
    expect(detectMcpLossyLoad(mobileCanonical)).toEqual([
      { setId: mobileCanonical.sets[0]!.id, field: 'chains', value: 15 },
      { setId: mobileCanonical.sets[0]!.id, field: 'eccentric', value: 20 },
    ]);

    // MCP fromCanonical flattens to weightLbs only — chains/ecc have no columns
    const mcpStored = mcpCodec.fromCanonical(mobileCanonical);
    expect(mcpStored.sets[0]!.weightLbs).toBe(60);
    expect(mcpStored.sets[0]).not.toHaveProperty('chains');
    expect(mcpStored.sets[0]).not.toHaveProperty('eccentric');

    // a mobile→canonical→MCP→canonical trip loses them (not parked in extra)
    const back = mcpCodec.toCanonical(mcpStored);
    expect(back.sets[0]!.load).toEqual({ weight: 60, chains: 0, eccentric: 0 });
  });
});

describe('4. lossy — derivedVbt (mobile-lossy)', () => {
  it('survives MCP-side verbatim; the mobile projection has no channel for it', () => {
    const fixture = makeMcpFixture();
    const mcpCanonical = mcpCodec.toCanonical(fixture);

    // derivedVbt preserved verbatim in repMeta, index-aligned, never spread onto WA Rep
    expect(mcpCanonical.sets[0]!.repMeta![0]!.derivedVbt).toEqual(
      fixture.sets[0]!.reps[0]!.derived,
    );
    expect(mcpCanonical.sets[0]!.analytics.reps[0]!).not.toHaveProperty('derived');

    // projecting the canonical set down to the mobile stored-rep shape drops it entirely
    const mobileReps = canonicalSetToMobileReps(mcpCanonical.sets[0]!);
    expect(JSON.stringify(mobileReps)).not.toContain('derived');
    expect(JSON.stringify(mobileReps)).not.toContain('correctedMeanVelocity');
  });
});

describe('5. non-crossing — plan vs program_assignments', () => {
  it('each adapter reads only its own extra namespace; foreign payload rides opaquely', () => {
    const mobileCanonical = mobileCodec.toCanonical(makeMobileFixture());
    expect(mobileCanonical.extra?.mobile?.['plan']).toBeDefined();
    expect(mobileCanonical.extra?.mcp).toBeUndefined();

    const mcpCanonical = mcpCodec.toCanonical(makeMcpFixture());
    expect(mcpCanonical.extra?.mcp?.['programAssignments']).toBeDefined();
    expect(mcpCanonical.extra?.mobile).toBeUndefined();

    // MCP adapter never populates a program from a foreign mobile plan
    const mcpFromMobile = mcpCodec.fromCanonical(mobileCanonical);
    expect(mcpFromMobile.assignments).toBeUndefined();
  });
});

describe('6. timestamp boundary', () => {
  it('MCP ISO ⇄ EpochMs round-trips with no sub-ms drift; endedAt null ⇄ absent', () => {
    const b = makeMcpFixture();
    const canonical = mcpCodec.toCanonical(b);
    expect(canonical.startedAt).toBe(Date.parse('2026-07-12T16:00:00.000Z'));

    const back = mcpCodec.fromCanonical(canonical);
    expect(back.session.startedAt).toBe('2026-07-12T16:00:00.000Z');
    expect(back.session.endedAt).toBe('2026-07-12T16:01:30.000Z');

    // in-progress session: no endedAt ⇒ null ⇒ ISO null
    const inProgress = makeMcpFixture();
    inProgress.session.endedAt = null;
    inProgress.sets[0]!.endedAt = null;
    const ipCanonical = mcpCodec.toCanonical(inProgress);
    expect(ipCanonical.endedAt).toBeNull();
    expect(ipCanonical.status).toBe('in_progress');
    expect(mcpCodec.fromCanonical(ipCanonical).session.endedAt).toBeNull();
  });
});

describe('7. status derivation (MCP)', () => {
  it('endedAt + no partial ⇒ completed; + partial ⇒ abandoned; absent ⇒ in_progress', () => {
    const completed = makeMcpFixture();
    expect(mcpCodec.toCanonical(completed).status).toBe('completed');

    const abandoned = makeMcpFixture();
    abandoned.sets[0]!.partial = true;
    expect(mcpCodec.toCanonical(abandoned).status).toBe('abandoned');

    const inProgress = makeMcpFixture();
    inProgress.session.endedAt = null;
    expect(mcpCodec.toCanonical(inProgress).status).toBe('in_progress');

    // mobile carries status explicitly — agrees with the fixture
    expect(mobileCodec.toCanonical(makeMobileFixture()).status).toBe('completed');
  });
});
