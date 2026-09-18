/**
 * The one rule every live surface uses to colour a set's fatigue (VW-440): the live
 * stage, the diverging dual stage, the rest recap and the pinned strip.
 *
 * `stop` is the server's own threshold for the set ({@link FatigueStop}: its watch, else
 * the exercise's plan intent, else the named default), so the wall turns red when the
 * server's `velocity_loss_exceeded` fires. WA's combined verdict also stops a set on form
 * breakdown (a ROM or eccentric alarm, titan's `auraForVerdict` rule). The approaching band
 * starts at the stop's second colour edge (`stop.bands[1]`, server-resolved, VW-448), or on
 * any other non-ok WA verdict tone.
 */
import type { FatigueVerdict } from '@voltras/workout-analytics';

import type { FatigueStop } from '../../../state/velocity-loss-intent.js';

export type { FatigueStop } from '../../../state/velocity-loss-intent.js';

/** `productive` keep going, `threshold` approaching the stop, `stop` end the set. */
export type FatigueState = 'productive' | 'threshold' | 'stop';

export interface SetFatigueInput {
  /** Velocity loss vs the set's best rep (%); null before a second rep lands. */
  lossPct: number | null;
  stop: FatigueStop;
  /** WA `getSetFatigueVerdict` for the same set, when the surface has its reps. */
  verdict?: FatigueVerdict | null;
}

export function setFatigueState({ lossPct, stop, verdict }: SetFatigueInput): FatigueState {
  if (lossPct !== null && lossPct >= stop.pct) return 'stop';
  if (verdict?.state === 'form-breakdown') return 'stop';
  if (lossPct !== null && lossPct >= stop.bands[1]) return 'threshold';
  if (verdict != null && verdict.tone !== 'ok') return 'threshold';
  return 'productive';
}
