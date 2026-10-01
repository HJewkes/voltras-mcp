// Delivery emitter and tee for the cue-delivery layer (VW-140 plan 3.1, slice S5).
//
// Composes the interval tracker, tier density, budget, focus, tone and focus selection
// into one per-slot speaker. Clock, platform, randomness and every live lookup arrive
// as dependencies, so the module reads nothing from the process.

import type { Rep } from '@voltras/workout-analytics';

import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { Tier } from '../../tools/tier-signal.js';
import { decideCue, type CueDecision } from '../cue-policy.js';
import type { CueSettings } from '../cue-settings.js';
import { slotFill, type CueSelector } from '../cue-templates.js';
import {
  admit,
  createLedger,
  defaultIntraSetPermit,
  type CueLedger,
  type CueLine,
  type IntraSetPermit,
  type LedgerEntry,
} from './budget.js';
import { focusPhrase, reinforcementPhrase } from './focus-phrases.js';
import { readSetFaults } from './focus-select.js';
import {
  beginSet,
  EMPTY_FOCUS_STATE,
  focusForSet,
  recordSetOutcome,
  reinforcementForSet,
  type CueFocusId,
  type FocusState,
} from './focus.js';
import {
  EMPTY_INTERVAL_STATE,
  intervalFor,
  trackInterval,
  type Interval,
  type IntervalEventKind,
  type IntervalState,
} from './interval.js';
import { readProximity, type ProximityInputs } from './proximity.js';
import { registerFor } from './tone.js';

/** Owner question 1, default yes: announcements spend the same interval budget as focus lines. */
export const ANNOUNCEMENTS_SHARE_BUDGET = true;

/** Engineering default, not a cited figure: reps between two intra-set lines on one slot. */
export const REMINDER_SPACING_REPS = 2;

/** The slot an event without a `slot` meta key belongs to. */
export const DEFAULT_SLOT = 'primary';

/** The coach-line source a spoken focus line carries; announcements carry their category. */
export const FOCUS_LINE_SOURCE = 'focus';

export interface SpeakRequest {
  text: string;
  interrupt: boolean;
  blocking: false;
}

export type SpeakLine = (request: SpeakRequest, source: string) => Promise<unknown>;

export interface SetContext {
  slot: string;
  setId: string;
}

/** Live effort and velocity-loss window for a set; rep_finalized carries no effort fields. */
export type SetSignals = Pick<
  ProximityInputs,
  'effort' | 'lossThresholdPct' | 'leadInReps' | 'romDecayVerdict'
>;

export interface DeliveryRecord extends LedgerEntry {
  at: number;
  text: string;
}

export interface DeliveryEmitterDeps {
  speak: SpeakLine;
  platform: NodeJS.Platform;
  clock: () => number;
  /** Held by reference and read on every event, as `system.set_cues` mutates it. */
  settings: CueSettings;
  selector: CueSelector;
  tierFor: (context: SetContext) => Promise<Tier>;
  exerciseFor: (context: SetContext) => string | null;
  repsFor: (context: SetContext) => readonly Rep[];
  signalsFor?: (context: SetContext) => SetSignals;
  intraSetPermit?: IntraSetPermit;
  onDecision?: (record: DeliveryRecord) => void;
}

interface Candidate {
  line: CueLine;
  text: string;
  interrupt: boolean;
  source: string;
}

interface SlotSet {
  setId: string;
  exerciseId: string | null;
  tier: Tier | null;
  ledger: CueLedger;
  announcementLedger: CueLedger;
  events: ChannelEvent[];
  repsSinceLine: number;
  /** Announcements raised in the current tick, or `null` when no decision is queued. */
  moment: CueDecision[] | null;
}

const INTERVAL_EVENTS: readonly string[] = [
  'set_started',
  'rep_finalized',
  'set_ended',
] satisfies IntervalEventKind[];

// Plan 3.6: slowdown beats a due focus reminder, which beats target_hit.
const SLOWDOWN_RANK = 0;
const REMINDER_RANK = 1;
const OTHER_ANNOUNCEMENT_RANK = 2;

export class DeliveryEmitter {
  private intervals: IntervalState = EMPTY_INTERVAL_STATE;
  private focus: FocusState = EMPTY_FOCUS_STATE;
  private readonly slots = new Map<string, SlotSet>();

  constructor(private readonly deps: DeliveryEmitterDeps) {}

  onEvent(event: ChannelEvent): void {
    const setId = event.meta.set_id;
    if (!setId) return;
    const context: SetContext = { slot: event.meta.slot ?? DEFAULT_SLOT, setId };
    const kind = event.meta.event_type;
    if (kind === 'set_started') this.startSet(context);
    const current = this.slots.get(context.slot);
    if (current?.setId !== setId) return;
    current.events.push(event);
    if (isIntervalEvent(kind)) {
      this.intervals = trackInterval(this.intervals, { kind, slot: context.slot, setId });
    }
    if (kind === 'set_ended') this.recordOutcome(context, current);
    if (kind === 'set_started' && this.canSpeak()) {
      this.deliverAll(context, current, this.preSetCandidates(context, decideCue(event)));
    } else if (kind === 'set_ended' && this.canSpeak()) {
      this.deliverAll(context, current, this.postSetCandidates(context, current, decideCue(event)));
    } else if (this.intervalOf(context) === 'intra') {
      this.raiseIntra(context, current, event);
    }
  }

  private canSpeak(): boolean {
    return this.deps.platform === 'darwin' && this.deps.settings.enabled;
  }

  private intervalOf(context: SetContext): Interval | null {
    return intervalFor(this.intervals, context.slot)?.interval ?? null;
  }

  private startSet(context: SetContext): void {
    const exerciseId = this.deps.exerciseFor(context);
    const slotSet: SlotSet = {
      setId: context.setId,
      exerciseId,
      tier: null,
      ledger: createLedger(),
      announcementLedger: createLedger(),
      events: [],
      repsSinceLine: 0,
      moment: null,
    };
    this.slots.set(context.slot, slotSet);
    if (exerciseId !== null) {
      this.focus = beginSet(this.focus, { exerciseId, setId: context.setId });
    }
    this.resolveTier(context, slotSet);
  }

  private resolveTier(context: SetContext, slotSet: SlotSet): void {
    try {
      this.deps.tierFor(context).then(
        (tier) => {
          slotSet.tier = tier;
        },
        () => undefined,
      );
    } catch {
      // A failed lookup leaves the strictest density in place.
    }
  }

  private recordOutcome(context: SetContext, slotSet: SlotSet): void {
    if (slotSet.exerciseId === null) return;
    const faults = readSetFaults(this.deps.repsFor(context));
    this.focus = recordSetOutcome(this.focus, { setId: context.setId, faults });
  }

  private preSetCandidates(context: SetContext, decision: CueDecision | null): Candidate[] {
    const focusId = focusForSet(this.focus, context.setId);
    return [
      ...this.announcement(decision),
      ...(focusId === null ? [] : [focusCandidate(focusId, focusPhrase(focusId, 'affirming'))]),
    ];
  }

  private postSetCandidates(
    context: SetContext,
    slotSet: SlotSet,
    decision: CueDecision | null,
  ): Candidate[] {
    const reinforced = reinforcementForSet(this.focus, context.setId);
    const next = this.nextFocus(slotSet);
    return [
      ...(reinforced === null ? [] : [focusCandidate(reinforced, reinforcementPhrase(reinforced))]),
      ...(next === null ? [] : [focusCandidate(next, focusPhrase(next, 'affirming'))]),
      ...this.announcement(decision),
    ];
  }

  private nextFocus(slotSet: SlotSet): CueFocusId | null {
    if (slotSet.exerciseId === null) return null;
    return this.focus.exercises.get(slotSet.exerciseId)?.current ?? null;
  }

  /** The bridge publishes a rep's trigger events in the same tick as the rep, so decide once after. */
  private raiseIntra(context: SetContext, slotSet: SlotSet, event: ChannelEvent): void {
    if (event.meta.event_type === 'rep_finalized') slotSet.repsSinceLine++;
    const decision = decideCue(event);
    if (slotSet.moment === null) {
      slotSet.moment = [];
      queueMicrotask(() => this.decideMoment(context, slotSet));
    }
    if (decision !== null) slotSet.moment.push(decision);
  }

  /** Plays the best-ranked line the budget admits for this moment, and nothing else. */
  private decideMoment(context: SetContext, slotSet: SlotSet): void {
    const decisions = slotSet.moment ?? [];
    slotSet.moment = null;
    if (this.slots.get(context.slot) !== slotSet || this.intervalOf(context) !== 'intra') return;
    if (!this.canSpeak()) return;
    const reminder = this.reminder(context, slotSet);
    const ranked = [
      ...decisions.flatMap((decision) => this.announcement(decision)),
      ...(reminder === null ? [] : [reminder]),
    ].sort((a, b) => intraRank(a.line) - intraRank(b.line));
    const chosen = ranked.find((candidate) => this.admitted(context, slotSet, 'intra', candidate));
    if (chosen !== undefined) this.play(slotSet, 'intra', chosen);
  }

  private reminder(context: SetContext, slotSet: SlotSet): Candidate | null {
    const focusId = focusForSet(this.focus, context.setId);
    if (focusId === null || slotSet.repsSinceLine < REMINDER_SPACING_REPS) return null;
    const reading = readProximity({
      setId: context.setId,
      events: slotSet.events,
      ...this.deps.signalsFor?.(context),
    });
    return focusCandidate(focusId, focusPhrase(focusId, registerFor(reading)));
  }

  private announcement(decision: CueDecision | null): Candidate[] {
    if (decision === null) return [];
    const template = this.deps.selector.pick(decision.category, Object.keys(decision.slots));
    return [
      {
        line: { kind: 'announcement', category: decision.category },
        text: slotFill(template, decision.slots),
        interrupt: decision.priority === 'urgent',
        source: decision.category,
      },
    ];
  }

  private deliverAll(context: SetContext, slotSet: SlotSet, candidates: Candidate[]): void {
    const interval = this.intervalOf(context);
    if (interval === null) return;
    for (const candidate of candidates) {
      if (this.admitted(context, slotSet, interval, candidate)) {
        this.play(slotSet, interval, candidate);
      }
    }
  }

  private admitted(
    context: SetContext,
    slotSet: SlotSet,
    interval: Interval,
    candidate: Candidate,
  ): boolean {
    const ledger = ledgerFor(slotSet, candidate.line);
    const decision = admit(ledger, {
      ...context,
      interval,
      line: candidate.line,
      tier: slotSet.tier,
      settings: this.deps.settings,
      intraSetPermit: this.deps.intraSetPermit ?? defaultIntraSetPermit,
    });
    const entry = ledger.entries[ledger.entries.length - 1];
    this.deps.onDecision?.({ ...entry, at: this.deps.clock(), text: candidate.text });
    return decision.admit;
  }

  private play(slotSet: SlotSet, interval: Interval, candidate: Candidate): void {
    if (interval === 'intra') slotSet.repsSinceLine = 0;
    const request: SpeakRequest = {
      text: candidate.text,
      interrupt: candidate.interrupt,
      blocking: false,
    };
    void this.deps.speak(request, candidate.source).catch(() => undefined);
  }
}

function isIntervalEvent(kind: string | undefined): kind is IntervalEventKind {
  return kind !== undefined && INTERVAL_EVENTS.includes(kind);
}

function intraRank(line: CueLine): number {
  if (line.kind === 'focus') return REMINDER_RANK;
  return line.category === 'slowdown' ? SLOWDOWN_RANK : OTHER_ANNOUNCEMENT_RANK;
}

function focusCandidate(focusId: CueFocusId, text: string): Candidate {
  return { line: { kind: 'focus', focusId }, text, interrupt: false, source: FOCUS_LINE_SOURCE };
}

function ledgerFor(slotSet: SlotSet, line: CueLine): CueLedger {
  if (line.kind === 'announcement' && !ANNOUNCEMENTS_SHARE_BUDGET) {
    return slotSet.announcementLedger;
  }
  return slotSet.ledger;
}

/**
 * Forwards every event to `inner` unchanged, then feeds it to the delivery emitter. A
 * slot-scoped tee stamps its slot on the emitter's copy only, since the inner adds it.
 */
export class DeliveryTee implements ChannelPublisher {
  constructor(
    private readonly inner: ChannelPublisher,
    private readonly emitter: DeliveryEmitter,
    private readonly slot: string | null = null,
  ) {}

  publish(event: ChannelEvent): void {
    this.inner.publish(event);
    try {
      this.emitter.onEvent(
        this.slot === null ? event : { ...event, meta: { slot: this.slot, ...event.meta } },
      );
    } catch {
      // Cues are best-effort; channel delivery never depends on them.
    }
  }

  forSlot(slotId: string): ChannelPublisher {
    return new DeliveryTee(this.inner.forSlot(slotId), this.emitter, slotId);
  }
}
