// The spoken coaching cues `src/voice/cue-templates.ts` picks from (VW-727), as
// sourced fragments. `${slot}` slots are filled by that module's `slotFill`.

import type { Fragment } from './fragments.js';

const MOTIVATIONAL =
  'Motivational wording written for the voice layer; no corpus or paper claim sets any of it.';
const MEASURED_LOSS = 'Reports a slowdown the set measured; the urging around it is our wording.';
const SET_READOUT =
  'Reads back the reps, time and loss the set recorded; the closing word is our wording.';

function cues(category: string, reason: string, texts: readonly string[]): readonly Fragment[] {
  return texts.map((text, index) => ({
    id: `cue.${category}.${index + 1}`,
    text,
    sourceKind: 'engineering-default',
    sourceRef: reason,
  }));
}

export const CUE_FRAGMENTS = {
  setIntro: cues('set-intro', MOTIVATIONAL, [
    'Set ${ordinal}, ${weight} pounds — let’s go.',
    'Set ${ordinal} at ${weight} pounds. Send it.',
    '${weight} pounds this set. Own it.',
    'Rack’s loaded to ${weight}. Go.',
    'Set ${ordinal} — bring the intensity.',
    'This is set ${ordinal}. Lock in.',
    'Next set — let’s go.',
    'Fresh set. Make it count.',
  ]),
  targetHit: cues('target-hit', MOTIVATIONAL, [
    'That’s your ${target} — bonus reps now.',
    'Target ${target} hit at ${actual}. Keep going.',
    '${actual} reps — you cleared ${target}.',
    'Goal reached: ${target}. Everything now is extra.',
    'You hit ${target}. Free reps from here.',
    '${target} down. Push for more.',
    'Past ${target} now — ${actual} and climbing.',
  ]),
  slowdown: cues('slowdown', MEASURED_LOSS, [
    'Velocity down ${pct} percent. Stay tight.',
    'That rep was ${pct} percent slower. Reset.',
    'Down ${pct} percent — make each rep count.',
    'Rep ${rep} slowed — control it.',
    'Losing speed on rep ${rep}. Brace.',
    'Speed’s dropping — keep every rep clean.',
    'Bar speed fading. Finish strong.',
  ]),
  setComplete: cues('set-complete', SET_READOUT, [
    'Nice — ${reps} reps, done.',
    '${reps} reps in ${seconds} seconds. Solid.',
    'Done in ${seconds} seconds. ${reps} strong reps.',
    'Set done — ${reps} reps, ${loss} percent drop.',
    '${reps} reps, ${loss} percent velocity loss. Logged.',
    'That’s ${reps}. Rest up.',
    'Set complete — ${reps} reps banked.',
  ]),
} as const;

export const CUE_FRAGMENT_LIST: readonly Fragment[] = Object.values(CUE_FRAGMENTS).flat();
