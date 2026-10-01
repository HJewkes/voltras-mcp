// Proximity-to-failure reading for the cue-delivery tone gate (VW-140 plan 3.5).
//
// Built from one set's channel events in arrival order. Rep numbers are never read, so
// relabelling them cannot move the reading; only measured decay and effort signals can.

import type { CueState, EffortConfidence, EffortRep } from '@voltras/workout-analytics';

import type { RomDecayReading } from '../../analytics/rom-integrity.js';
import {
  isOutlier,
  ROM_OUTLIER_RATIO,
  VELOCITY_OUTLIER_RATIO,
} from '../../state/rep-eligibility.js';

/** The events that mean the set's ending cue has already fired. */
export const ENDING_EVENTS = ['velocity_loss_exceeded', 'effort_target_reached'] as const;

export type EndingEvent = (typeof ENDING_EVENTS)[number];

/** Every field is `null` when its signal is absent; a null never escalates the tone. */
export interface ProximityReading {
  cueState: CueState | null;
  rir: number | null;
  confidence: EffortConfidence | null;
  /** Loss from the set's fastest eligible rep to its latest rep, as the live watch measures it. */
  lossPct: number | null;
  lossThresholdPct: number | null;
  romDecayVerdict: RomDecayReading['verdict'];
  endingEvent: EndingEvent | null;
}

export interface ChannelEvent {
  meta: Readonly<Record<string, string>>;
  content: string;
}

export interface ProximityInputs {
  setId: string;
  /** The session's channel events in arrival order; other sets' events are ignored. */
  events: readonly ChannelEvent[];
  effort?: Pick<EffortRep, 'cueState' | 'confidence' | 'rir'> | null;
  /** The set's velocity-loss watch threshold; a fired loss event supplies it when absent. */
  lossThresholdPct?: number | null;
  romDecayVerdict?: RomDecayReading['verdict'];
  /** Head-of-set reps the velocity-loss window excludes, as `velocityLossWindow` reports. */
  leadInReps?: number;
}

interface StreamedRep {
  peakVelocity: number;
  rom: number | null;
}

export function readProximity(inputs: ProximityInputs): ProximityReading {
  const events = inputs.events.filter((event) => event.meta.set_id === inputs.setId);
  const reps = events.flatMap(streamedRep).slice(inputs.leadInReps ?? 0);
  const ending = events.find((event) => isEndingEvent(event.meta.event_type));
  return {
    cueState: inputs.effort?.cueState ?? null,
    rir: inputs.effort?.rir ?? null,
    confidence: inputs.effort?.confidence ?? null,
    lossPct: velocityLossPct(reps),
    lossThresholdPct: inputs.lossThresholdPct ?? thresholdFrom(events),
    romDecayVerdict: inputs.romDecayVerdict ?? null,
    endingEvent: ending === undefined ? null : (ending.meta.event_type as EndingEvent),
  };
}

function isEndingEvent(eventType: string | undefined): boolean {
  return (ENDING_EVENTS as readonly (string | undefined)[]).includes(eventType);
}

function streamedRep(event: ChannelEvent): StreamedRep[] {
  if (event.meta.event_type !== 'rep_finalized') return [];
  const rep = parseObject(event.content)?.rep as
    | { concentric?: { peak_velocity?: unknown }; rom_m?: unknown }
    | undefined;
  const peakVelocity = rep?.concentric?.peak_velocity;
  if (typeof peakVelocity !== 'number' || !Number.isFinite(peakVelocity)) return [];
  return [{ peakVelocity, rom: typeof rep?.rom_m === 'number' ? rep.rom_m : null }];
}

function thresholdFrom(events: readonly ChannelEvent[]): number | null {
  const fired = events.find((event) => event.meta.event_type === 'velocity_loss_exceeded');
  const threshold = Number(fired?.meta.threshold_pct);
  return fired !== undefined && Number.isFinite(threshold) ? threshold : null;
}

function velocityLossPct(reps: readonly StreamedRep[]): number | null {
  if (reps.length < 2) return null;
  const baseline = Math.max(...eligibleReps(reps).map((rep) => rep.peakVelocity));
  if (baseline <= 0) return null;
  const current = reps[reps.length - 1].peakVelocity;
  return Math.max(0, (100 * (baseline - current)) / baseline);
}

// The same relative outlier rule `selectEligibleReps` applies, over the streamed figures.
function eligibleReps(reps: readonly StreamedRep[]): readonly StreamedRep[] {
  const measurable = reps.filter((rep) => rep.peakVelocity > 0 && rep.rom !== null);
  const kept = measurable.filter((rep) => {
    const others = measurable.filter((other) => other !== rep);
    if (others.length === 0) return false;
    const roms = others.map((other) => other.rom as number);
    if (isOutlier(rep.rom as number, roms, ROM_OUTLIER_RATIO)) return false;
    const velocities = others.map((other) => other.peakVelocity);
    return !isOutlier(rep.peakVelocity, velocities, VELOCITY_OUTLIER_RATIO);
  });
  return kept.length === 0 ? reps : kept;
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
