// The set-risk intra-set permit (VW-614, VW-152 plan section 5). Every reading is synthetic.

import { describe, expect, it } from 'vitest';

import type { RiskBand, SetRiskReading } from '../../../analytics/set-risk.js';
import type { CuesMidSetMode } from '../../../config.js';
import { LiveState } from '../../../state/live-state.js';
import { makeCueSettings } from '../../cue-settings.js';
import { riskIntraSetPermit, type SetRiskReadingFor } from '../risk-permit.js';

function reading(band: RiskBand, permitsIntraSet = band === 'green'): SetRiskReading {
  return {
    band,
    points: band === 'green' ? 0 : 4,
    factors: { exercise: 0, intensity: 0, load: 0, fatigue: 0 },
    vetoes: band === 'red' ? ['heavy_loaded_compound'] : [],
    permitsIntraSet,
  };
}

function context(mode: CuesMidSetMode, setId = 'set-1') {
  return { slot: 'primary', setId, settings: makeCueSettings({ cues: 'on', cuesMidSet: mode }) };
}

const always =
  (value: SetRiskReading | undefined): SetRiskReadingFor =>
  () =>
    value;

/** A live slot with `set-1` active and `pinned` attached to it. */
function liveWithPin(pinned: SetRiskReading): SetRiskReadingFor {
  const live = new LiveState();
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
  });
  live.attachSetRiskReading('set-1', pinned);
  return (slot, setId) => (slot === 'primary' ? live.setRiskReadingFor(setId) : undefined);
}

describe('riskIntraSetPermit', () => {
  it('denies under off, even with a green reading', () => {
    expect(riskIntraSetPermit(always(reading('green')))(context('off'))).toBe(false);
  });

  it('permits under on, even with a red reading or none', () => {
    expect(riskIntraSetPermit(always(reading('red')))(context('on'))).toBe(true);
    expect(riskIntraSetPermit(always(undefined))(context('on'))).toBe(true);
  });

  it('permits under risk when the active set carries a green reading', () => {
    expect(riskIntraSetPermit(liveWithPin(reading('green')))(context('risk'))).toBe(true);
  });

  it('denies under risk when the green reading belongs to another set', () => {
    const permit = riskIntraSetPermit(liveWithPin(reading('green')));

    expect(permit(context('risk', 'set-2'))).toBe(false);
  });

  it('denies under risk when no reading is pinned', () => {
    expect(riskIntraSetPermit(always(undefined))(context('risk'))).toBe(false);
  });

  it.each<RiskBand>(['amber', 'red'])('denies under risk on a %s reading', (band) => {
    expect(riskIntraSetPermit(always(reading(band)))(context('risk'))).toBe(false);
  });

  it('denies under risk when the band and the permit flag disagree', () => {
    expect(riskIntraSetPermit(always(reading('amber', true)))(context('risk'))).toBe(false);
    expect(riskIntraSetPermit(always(reading('green', false)))(context('risk'))).toBe(false);
  });

  it('denies under risk when the reading lookup throws', () => {
    const permit = riskIntraSetPermit(() => {
      throw new Error('live state unavailable');
    });

    expect(permit(context('risk'))).toBe(false);
  });

  it('denies an unknown mode', () => {
    const ctx = context('on');
    const settings = { ...ctx.settings, midSetMode: 'spotter' as CuesMidSetMode };

    expect(riskIntraSetPermit(always(reading('green')))({ ...ctx, settings })).toBe(false);
  });
});
