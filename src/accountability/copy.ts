// The coach's five message templates, as typed constants (VW-287). The same
// five appear verbatim in the workspace reference doc
// `sources/reference/coach-copy-pack.md`, which annotates each with the copy
// rule from `sources/notes/2026-09-12-accountability-system-plan.md` §2 that it
// satisfies. The doc is the human-readable record; this file is what ships.
//
// Nothing here sends. `composer.ts` renders these against structured inputs and
// the state machine decides when a rendered message goes out.
//
// The texts and their sources live in `src/coach-copy/accountability.ts`
// (VW-725); the names below are the ones the composer and tests import.
//
// `{{token}}` placeholders are filled by `composer.ts`. A line that renders
// empty is dropped, which is how the optional monthly commitment re-offer
// disappears on the other three Sundays of the month.

import { ACCOUNTABILITY_FRAGMENTS } from '../coach-copy/accountability.js';

/**
 * Stands in for the lifter's own commitment wording until the Sunday
 * goal-setting sitting (VW-236) produces it. Rendered literally when no
 * wording has been captured, so an unfilled slot is visible in the message
 * rather than silently absent: the commitment has to be self-authored to carry
 * any weight (plan §2, LIT §1.2).
 */
export const COMMITMENT_LANGUAGE_PLACEHOLDER = '<<COMMITMENT_LANGUAGE>>';

/**
 * Copy rule 3: the explicit non-judgment line, which always precedes the
 * operational-honesty line. Reversing the two turns an operational request
 * into an accusation with a disclaimer attached.
 */
export const NON_JUDGMENT_LINE = ACCOUNTABILITY_FRAGMENTS.nonJudgment.text;

/** Copy rule 3: honesty as an operating requirement, never a moral one. */
export const OPERATIONAL_HONESTY_LINE = ACCOUNTABILITY_FRAGMENTS.operationalHonesty.text;

/**
 * Plan §2 "Thursday" decision: an absent mid-week message is only informative
 * if the lifter was told once what silence means.
 */
export const SILENCE_MEANS_ON_TRACK_LINE = ACCOUNTABILITY_FRAGMENTS.silenceMeansOnTrack.text;

/**
 * The weekly anchor. Shows last week's telemetry back instead of asking how it
 * went (plan §2, Sunday goal-setting), re-asks the if-then plan, confirms each
 * slot's named fallback, and carries the rolling 28-day count in place of a
 * streak (copy rule 7).
 */
export const SUNDAY_ANCHOR = ACCOUNTABILITY_FRAGMENTS.sundayAnchor.text;

/**
 * Fires on entry to `missed`. Names the miss with no evaluation, offers exactly
 * one reduced-scope re-entry sourced from `plan.next_workout`, and puts it on a
 * named day (plan §2 miss-recovery; child-ticket row 11).
 */
export const MISS_RECOVERY = ACCOUNTABILITY_FRAGMENTS.missRecovery.text;

/**
 * The same missed day inside a declared hold. Miss framing is suppressed
 * entirely: a hold is a window the plan expects to be empty (plan §2 `holding`,
 * RP S11 disruption rules), so this names no miss and prescribes no day.
 */
export const HOLDING_ACKNOWLEDGEMENT = ACCOUNTABILITY_FRAGMENTS.holdingAcknowledgement.text;

/**
 * Ghost nudge 1 of 2. Standalone by construction: it carries no back-reference,
 * no running count and no escalation of urgency (copy rule 2, RP ghost
 * protocol).
 */
export const GHOST_NUDGE_1 = ACCOUNTABILITY_FRAGMENTS.ghostNudge1.text;

/**
 * Ghost nudge 2 of 2, and the last proactive message before outreach stops.
 * Reads as a first contact on purpose: it never refers to nudge 1, because a
 * nudge that counts its predecessors is a running total (copy rule 2).
 */
export const GHOST_NUDGE_2 = ACCOUNTABILITY_FRAGMENTS.ghostNudge2.text;

/**
 * The realign conversation opener, which is also the escalation ceiling:
 * nothing past this happens without the human (plan §2 stop conditions). The
 * frequency offer is a re-architecture within the same number of days, never a
 * reduction (copy rule 4, RP S5 tier reversal).
 */
export const REALIGN_OPENER = ACCOUNTABILITY_FRAGMENTS.realignOpener.text;
