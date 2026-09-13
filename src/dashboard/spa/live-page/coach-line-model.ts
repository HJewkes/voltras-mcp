// The spoken-coaching-line caption's read-model (VW-289): what the wall prints under the
// rest timer after the trainer says something, and for how long.
//
// Pure and node-testable, the same posture as `isometric-verdict-model.ts` — the caption
// renders whatever this returns and decides nothing. Every dismissal rule lives here.

import type { LiveCoachLineSignal } from '../../../state/live-signal';

/**
 * How long a line stays captioned, in ms.
 *
 * A cue is one sentence, heard once, from across the room. Twelve seconds is long enough
 * to read it twice after realising it was said, and short enough that the caption is gone
 * well before the next set — a line still on the wall when the lifter re-racks would read
 * as current advice. Nothing validates this number; it is a dwell chosen to be read.
 */
export const COACH_LINE_DWELL_MS = 12_000;

/** What the caption prints, or null when there is nothing to show. */
export interface CoachLineCaption {
  text: string;
  /** All-caps attribution: `COACH` for a spoken line, else the cue category. */
  label: string;
}

/** The `source` a `system.speak` call carries — mirrors `SPEAK_LINE_SOURCE` server-side. */
const SPEAK_SOURCE = 'speak';

/**
 * How the caption attributes the line. A `system.speak` call is the trainer talking, so it
 * reads `COACH`; a deterministic cue names its own category, because "the server said this
 * because the set hit its target" is a different claim from "the coach chose to say it".
 */
function attributionLabel(source: string): string {
  if (source === SPEAK_SOURCE) return 'COACH';
  return source.replace(/_/g, ' ').toUpperCase();
}

export interface CoachLineInput {
  /** The latest spoken line, or null if none has arrived this session. */
  line: LiveCoachLineSignal | null;
  /** The store's 1 Hz clock. */
  nowMs: number;
}

/**
 * Decide whether the caption shows, and what it says. Latest line wins by construction:
 * the store holds one line, so a new one overwrites the last and restarts the dwell.
 *
 * Empty text is ignored rather than captioned as a blank box — `say ''` makes no sound,
 * so there was nothing for the lifter to miss. A line whose `occurredAt` is ahead of the
 * clock counts as just-arrived: the store's tick is 1 Hz and starts at 0, so a caption
 * must not depend on the clock having caught up before it can show.
 */
export function deriveCoachLineCaption(input: CoachLineInput): CoachLineCaption | null {
  const { line, nowMs } = input;
  if (line === null) return null;
  const text = line.text.trim();
  if (text === '') return null;
  if (nowMs - line.occurredAt >= COACH_LINE_DWELL_MS) return null;
  return { text, label: attributionLabel(line.source) };
}
