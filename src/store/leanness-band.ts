// The self-reported leanness vocabulary (VW-364), in the same posture as
// `diet-phase.ts`: a transcription of words the corpus already uses, with no
// arithmetic over it.
//
// A BAND, NOT A NUMBER, AND THE BAND *IS* THE RESOLUTION. The RP corpus states
// in its own application line that this hardware cannot measure body fat, so a
// target range stays a UI default rather than a tracked metric, and its own
// leanness gradations are visual ("visible abdominal definition", "a fully
// visible six-pack"). The VW-346 design note reads those descriptors off and
// proposes exactly these four coarse bands; this module is that transcription.
//
// SELF-REPORTED AND NEVER INFERRED. Nothing derives a band from bodyweight,
// from a waist tape or from a body-fat percentage, and nothing converts a band
// back into a percentage. The four values are ordered from most fat to least
// only so a reader can sort them; no consumer reads a verdict off the order.

/**
 * The four coarse bands, most fat to least, anchored on RP's visual
 * descriptors as read off by the VW-346 design note:
 *
 * - `high` — no abdominal definition
 * - `moderate` — the band between the two anchored ends
 * - `lean` — visible abdominal definition
 * - `very-lean` — a fully visible six-pack
 *
 * Hyphenated to match `DIET_PHASES`' own `fat-loss`.
 */
export const LEANNESS_BANDS = ['high', 'moderate', 'lean', 'very-lean'] as const;

export type LeannessBand = (typeof LEANNESS_BANDS)[number];

/** Is `value` one of the four bands? */
export function isLeannessBand(value: string): value is LeannessBand {
  return (LEANNESS_BANDS as readonly string[]).includes(value);
}
