// The local voice weight fast-path (VMCP-02.87).
//
// Tier-A safety proved the pattern: recognize, act, then tell the model what
// happened. This does the same for weight changes — the command an athlete
// gives most often mid-set, and the one that suffers most from a model turn
// (observed on the bench: "set it to 70" worked but cost a full round-trip, and
// neighbouring transcriptions were dropped waiting on it).
//
// The parser (src/voice/weight-command.ts) decides WHAT was said; this decides
// WHETHER it can be applied — which slot, whether the number is in range, and
// what "cancel" reverts to. Everything that declines still reaches the model as
// an ordinary `voice_input` plus a loud `voice_command_rejected`.

import {
  buildVoiceCommandAppliedPayload,
  buildVoiceCommandRejectedPayload,
  buildVoiceInputPayload,
  type VoiceCommandRejectReason,
} from '../state/channel-payloads.js';
import type { ChannelPublisher } from '../state/channel-publisher.js';
import type { LeaseFence } from '../state/lease-fence.js';
import type { WeightCommand, WeightCommandSlot } from '../voice/weight-command.js';

/** Device-allowed range, mirroring the `device.set_weight` schema. */
export const MIN_WEIGHT_LBS = 5;
export const MAX_WEIGHT_LBS = 200;

/** What the fast-path needs to know about one connected slot. */
export interface VoiceWeightSlot {
  slot: string;
  /** Epoch ms the slot's active set started, or null when no set is armed. */
  activeSetStartedAtMs: number | null;
  /** Epoch ms the slot's last set ended, or null when it has closed none. */
  lastSetEndedAtMs: number | null;
  /** Last known device weight, or null when the slot has never reported one. */
  currentWeightLbs: number | null;
}

/**
 * Server-provided hooks, built from `ServerState` by {@link makeVoiceWeight}.
 * Slot ids are whatever is actually bound (`primary`, or `left`/`right`) —
 * never a hardcoded name (VMCP-02.86).
 */
export interface VoiceWeightContext {
  /** Connected slots only, in slot-map order. */
  slots(): VoiceWeightSlot[];
  setWeight(slot: string, lbs: number): Promise<void>;
}

export interface VoiceCommandEvent {
  command: WeightCommand;
  transcript: string;
  sttModel: string;
  latencyMs: number;
  audioDurationMs: number;
}

type SlotChoice = { slot: VoiceWeightSlot } | { reason: VoiceCommandRejectReason };
type WeightPlan = { lbs: number; clamped: boolean } | { reason: VoiceCommandRejectReason };

/**
 * Pick the slot a command targets. An explicit side word wins; otherwise the
 * slot that most recently had a set (active beats finished) does. Two connected
 * slots with no set history and no side word is genuinely ambiguous — guessing
 * would load the wrong cable, so the model gets it instead.
 */
export function resolveTargetSlot(
  slots: VoiceWeightSlot[],
  explicit: WeightCommandSlot | undefined,
): SlotChoice {
  if (slots.length === 0) return { reason: 'no_connected_slot' };
  if (explicit !== undefined) {
    const named = slots.find((candidate) => candidate.slot === explicit);
    return named === undefined ? { reason: 'slot_not_connected' } : { slot: named };
  }
  if (slots.length === 1) return { slot: slots[0] };
  const ranked = [...slots].sort((a, b) => recency(b) - recency(a));
  return recency(ranked[0]) === 0 ? { reason: 'ambiguous_slot' } : { slot: ranked[0] };
}

/** An armed set outranks any finished one, whatever the wall clock says. */
function recency(slot: VoiceWeightSlot): number {
  if (slot.activeSetStartedAtMs !== null) return Number.MAX_SAFE_INTEGER;
  return slot.lastSetEndedAtMs ?? 0;
}

/**
 * Resolve the command to a concrete target weight. An absolute target outside
 * the device range is refused rather than clamped — "set it to 500" is a
 * misheard number, not a request for 200. A relative step that runs off the end
 * is pinned to the bound and reported as `clamped`.
 */
export function planWeight(
  command: WeightCommand,
  slot: VoiceWeightSlot,
  undoTo: number | undefined,
): WeightPlan {
  if (command.kind === 'undo') {
    return undoTo === undefined ? { reason: 'nothing_to_undo' } : { lbs: undoTo, clamped: false };
  }
  if (command.kind === 'absolute') {
    return inRange(command.lbs) ? { lbs: command.lbs, clamped: false } : { reason: 'out_of_range' };
  }
  if (slot.currentWeightLbs === null) return { reason: 'unknown_current_weight' };
  const raw = slot.currentWeightLbs + command.deltaLbs;
  const lbs = Math.min(MAX_WEIGHT_LBS, Math.max(MIN_WEIGHT_LBS, raw));
  return { lbs, clamped: lbs !== raw };
}

function inRange(lbs: number): boolean {
  return Number.isInteger(lbs) && lbs >= MIN_WEIGHT_LBS && lbs <= MAX_WEIGHT_LBS;
}

/**
 * Build the per-listener handler. The closure holds a one-deep undo ledger per
 * slot: the weight the slot carried before its last local command, which is
 * what "cancel" / "never mind" reverts to. It is deliberately not persisted —
 * an undo only makes sense within the arming that produced the change.
 */
export function createWeightFastPath(
  channels: ChannelPublisher,
  context: VoiceWeightContext | null,
  leaseFence: LeaseFence | null = null,
): (event: VoiceCommandEvent) => Promise<void> {
  const undoLedger = new Map<string, number>();
  return async (event: VoiceCommandEvent): Promise<void> => {
    if (context === null) return reject(channels, event, 'no_weight_context');
    const choice = resolveTargetSlot(readSlots(context), event.command.slot);
    if ('reason' in choice) return reject(channels, event, choice.reason);
    const plan = planWeight(event.command, choice.slot, undoLedger.get(choice.slot.slot));
    if ('reason' in plan) return reject(channels, event, plan.reason, choice.slot.slot);
    // VMCP-01.65: the fence was taken when the mic was armed, which is when
    // this session last proved it held the device. Everything since — the
    // wake phrase, the STT round-trip — happened off that proof, so re-check
    // before writing. `lease_lost` alone here: a session that no longer holds
    // the device cannot act on the command either, so relaying the transcript
    // as a rejection would only invite a write that would also be refused.
    if (leaseFence !== null && !leaseFence.intact()) {
      leaseFence.report(choice.slot.slot);
      return;
    }
    await applyWeight(channels, context, undoLedger, { event, slot: choice.slot, plan });
  };
}

async function applyWeight(
  channels: ChannelPublisher,
  context: VoiceWeightContext,
  undoLedger: Map<string, number>,
  args: {
    event: VoiceCommandEvent;
    slot: VoiceWeightSlot;
    plan: { lbs: number; clamped: boolean };
  },
): Promise<void> {
  const { event, slot, plan } = args;
  try {
    await context.setWeight(slot.slot, plan.lbs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return reject(channels, event, 'set_failed', slot.slot, detail);
  }
  rememberUndo(undoLedger, slot, event.command.kind);
  channels.publish(
    buildVoiceCommandAppliedPayload({
      slot: slot.slot,
      kind: event.command.kind,
      lbs: plan.lbs,
      previousLbs: slot.currentWeightLbs,
      transcript: event.transcript,
      clamped: plan.clamped,
    }),
  );
}

/** One deep: an undo spends the entry rather than becoming its own undo point. */
function rememberUndo(
  undoLedger: Map<string, number>,
  slot: VoiceWeightSlot,
  kind: WeightCommand['kind'],
): void {
  if (kind === 'undo') {
    undoLedger.delete(slot.slot);
    return;
  }
  if (slot.currentWeightLbs !== null) undoLedger.set(slot.slot, slot.currentWeightLbs);
}

/** A throwing context must degrade to "model handles it", never to a crash. */
function readSlots(context: VoiceWeightContext): VoiceWeightSlot[] {
  try {
    return context.slots();
  } catch {
    return [];
  }
}

function reject(
  channels: ChannelPublisher,
  event: VoiceCommandEvent,
  reason: VoiceCommandRejectReason,
  slot?: string,
  detail?: string,
): void {
  channels.publish(
    buildVoiceCommandRejectedPayload({ transcript: event.transcript, reason, slot, detail }),
  );
  channels.publish(
    buildVoiceInputPayload(
      event.transcript,
      event.latencyMs,
      event.sttModel,
      event.audioDurationMs,
    ),
  );
}
