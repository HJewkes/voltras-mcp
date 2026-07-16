// Deterministic cue policy (VMCP-02.79 PR3). Maps an outbound
// `claude/channel` event to a spoken-cue decision, or `null` for the common
// (non-cue) case.
//
// PURE by design: `decideCue` has no internal state and no side effects — the
// same event always yields the same decision. Per-set fire-once dedup and the
// actual TTS emission live in the emitter (PR4); this module only classifies.
// Keeping it pure lets the policy be unit-tested against the real payload
// builders in `channel-payloads.ts` so slot extraction stays in lockstep with
// the producers.

import type { CueCategory } from './cue-templates.js';
import type { ChannelEvent } from '../state/channel-publisher.js';

export interface CueDecision {
  category: CueCategory;
  slots: Record<string, string | number>;
  priority: 'normal' | 'urgent';
  /** Used by the emitter for per-set fire-once dedup. On every payload meta. */
  setId: string;
}

/**
 * Classify a channel event into a cue decision, or `null` when the event
 * isn't cue-worthy (every event type other than the four below, or any event
 * missing a required field). Defensive: a missing `set_id` or a required slot
 * that parses to NaN yields `null` rather than a broken cue.
 */
export function decideCue(event: ChannelEvent): CueDecision | null {
  const setId = event.meta.set_id;
  if (!setId) {
    return null;
  }
  switch (event.meta.event_type) {
    case 'set_started':
      return decideSetIntro(event, setId);
    case 'set_target_reached':
      return decideTargetHit(event, setId);
    case 'velocity_loss_exceeded':
      return decideSlowdown(event, setId);
    case 'set_ended':
      return decideSetComplete(event, setId);
    default:
      return null;
  }
}

/** Parse a meta string to a finite number, or null when absent/NaN. */
function numOrNull(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** Parse a JSON content body into a plain object, or null on any failure. */
function parseContent(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `set_started` → set_intro. `weight` is included only when present (the
 * builder omits `weight_lbs` when weight is 0). `ordinal` is parsed from the
 * summary line ("… (set N of session)") when cleanly available, else omitted.
 */
function decideSetIntro(event: ChannelEvent, setId: string): CueDecision {
  const slots: Record<string, string | number> = {};
  const weight = numOrNull(event.meta.weight_lbs);
  if (weight !== null) {
    slots.weight = weight;
  }
  const ordinal = parseOrdinal(event.content);
  if (ordinal !== null) {
    slots.ordinal = ordinal;
  }
  return { category: 'set_intro', slots, priority: 'normal', setId };
}

/** Extract the 1-indexed set ordinal from the "(set N of session)" summary. */
function parseOrdinal(content: string): number | null {
  const parsed = parseContent(content);
  const summary = parsed?.summary;
  if (typeof summary !== 'string') {
    return null;
  }
  const match = /set (\d+) of session/.exec(summary);
  return match ? Number(match[1]) : null;
}

/** `set_target_reached` → target_hit. */
function decideTargetHit(event: ChannelEvent, setId: string): CueDecision | null {
  const target = numOrNull(event.meta.target_rep_count);
  const actual = numOrNull(event.meta.actual_rep_count);
  if (target === null || actual === null) {
    return null;
  }
  return { category: 'target_hit', slots: { target, actual }, priority: 'normal', setId };
}

/** `velocity_loss_exceeded` → slowdown (urgent — interrupts current speech). */
function decideSlowdown(event: ChannelEvent, setId: string): CueDecision | null {
  const pct = numOrNull(event.meta.velocity_loss_pct);
  const rep = numOrNull(event.meta.rep_count_at_threshold);
  if (pct === null || rep === null) {
    return null;
  }
  return { category: 'slowdown', slots: { pct, rep }, priority: 'urgent', setId };
}

/**
 * `set_ended` → set_complete. `loss` (peak-to-last velocity loss) is read from
 * the parsed content's `vbt_summary` and included only when it's a real number
 * (the builder emits null for sub-2-rep sets).
 */
function decideSetComplete(event: ChannelEvent, setId: string): CueDecision | null {
  const reps = numOrNull(event.meta.rep_count);
  const durationMs = numOrNull(event.meta.duration_ms);
  if (reps === null || durationMs === null) {
    return null;
  }
  const slots: Record<string, string | number> = { reps, seconds: Math.round(durationMs / 1000) };
  const loss = lossFromContent(event.content);
  if (loss !== null) {
    slots.loss = loss;
  }
  return { category: 'set_complete', slots, priority: 'normal', setId };
}

/** Pull `vbt_summary.velocity_loss_pct` from a set_ended content body. */
function lossFromContent(content: string): number | null {
  const vbt = parseContent(content)?.vbt_summary;
  if (typeof vbt !== 'object' || vbt === null) {
    return null;
  }
  const loss = (vbt as Record<string, unknown>).velocity_loss_pct;
  return typeof loss === 'number' ? loss : null;
}
