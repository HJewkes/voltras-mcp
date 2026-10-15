// Fixed spoken phrases per cue focus for the cue-delivery layer (VW-140 plan 3.4, 3.5).
//
// One phrase per focus per register, never rotated: repeating a focus repeats the same
// words. Each phrase records the source it rests on so the fragment registry can adopt it.

import type { CueFocusId } from './focus.js';

/** `affirming` early in a set; `directive` near failure, short and repeated verbatim. */
export type CueRegister = 'affirming' | 'directive';

export type PhraseSourceKind = 'rp' | 'engineering-default';

export interface PhraseSource {
  kind: PhraseSourceKind;
  /** Comma-separated RP claim ids for `rp`; a stated reason for `engineering-default`. */
  ref: string;
}

export interface FocusPhrase {
  text: string;
  source: PhraseSource;
}

export interface FocusPhraseSet {
  affirming: FocusPhrase;
  directive: FocusPhrase;
  reinforcement: FocusPhrase;
}

// These are the ids the live.cue_delivery coaching topic already cites for each rule.
const NEUTRAL_CORRECTION: PhraseSource = {
  kind: 'rp',
  ref: 'rp-s5-technique-feedback-tone-rule',
};
const SHORT_NEAR_FAILURE: PhraseSource = {
  kind: 'rp',
  ref: 'rp-s3-coaching-tone-shift-near-failure',
};
const REINFORCE_AFTER_RESOLVED: PhraseSource = {
  kind: 'rp',
  ref: 'rp-s3-consistency-of-cueing-over-weeks',
};

export const FOCUS_PHRASES: Readonly<Record<CueFocusId, Readonly<FocusPhraseSet>>> = Object.freeze({
  full_range: Object.freeze({
    affirming: { text: 'Take every rep through your full range.', source: NEUTRAL_CORRECTION },
    directive: { text: 'Full range.', source: SHORT_NEAR_FAILURE },
    reinforcement: { text: 'Good, your range held all set.', source: REINFORCE_AFTER_RESOLVED },
  }),
  control_lowering: Object.freeze({
    affirming: { text: 'Control the weight on the way down.', source: NEUTRAL_CORRECTION },
    directive: { text: 'Control down.', source: SHORT_NEAR_FAILURE },
    reinforcement: {
      text: 'Good, nice control on the way down.',
      source: REINFORCE_AFTER_RESOLVED,
    },
  }),
  smooth_drive: Object.freeze({
    affirming: { text: 'Drive up in one smooth push.', source: NEUTRAL_CORRECTION },
    directive: { text: 'Smooth drive.', source: SHORT_NEAR_FAILURE },
    reinforcement: { text: 'Good, that drive stayed smooth.', source: REINFORCE_AFTER_RESOLVED },
  }),
});

/** The one phrase for a focus in a register; the same call always returns the same text. */
export function focusPhrase(focusId: CueFocusId, register: CueRegister): string {
  return FOCUS_PHRASES[focusId][register].text;
}

/** The post-set line for a focus that has stopped reading as a fault. */
export function reinforcementPhrase(focusId: CueFocusId): string {
  return FOCUS_PHRASES[focusId].reinforcement.text;
}
