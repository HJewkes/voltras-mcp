// Push-event detail level at the client channel (VW-807 slice 2).
//
// `rep_finalized` and `set_ended` were the bulk of a live workout's context:
// every rep pushed its full phase breakdown and every set close repeated all
// of it. The model rarely reads past the summary line mid-set, and `set.get`
// returns full rep detail on demand.
//
// The compaction sits at the connection's own publisher, BELOW the cue layer
// and the isometric tee (see `wireProcessState` in `server.ts`), so spoken
// cues and the dashboard still read the full payloads the builders in
// `channel-payloads.ts` produce. `full` is a passthrough: the event reaching
// the transport is the very object the builder returned.

import type { ChannelEvent, ChannelPublisher } from './channel-publisher.js';
import type { PushDetail } from '../config.js';
import type { StoredRepVbt } from '../store/types.js';

type JsonObject = Record<string, unknown>;

/** Column order of the compact `set_ended.rep_table.rows`. */
export const REP_TABLE_COLUMNS = [
  'rep',
  'conc_peak_mps',
  'conc_mean_mps',
  'ecc_peak_mps',
  'rom_m',
  'tempo_ratio',
] as const;

/**
 * `set` fields a compact `set_ended` leaves out: the two ids the meta attributes
 * already carry, a deprecated alias, and a field that is always null on a closed set.
 */
const DROPPED_SET_FIELDS: ReadonlySet<string> = new Set([
  'set_id',
  'session_id',
  'training_mode',
  'active_mode',
]);

/**
 * `rep_finalized` keeps its meta attributes, its one-line summary and the rep's
 * peak force: on an isokinetic set the speed is fixed, so force is the live
 * signal, and the attributes carry only velocity.
 */
function compactRepFinalized(full: JsonObject): JsonObject {
  const rep = full.rep as JsonObject | undefined;
  return { summary: full.summary, peak_force: rep?.peak_force ?? null };
}

function repTableRow(rep: StoredRepVbt): Array<number | null> {
  return [
    rep.rep_number,
    rep.concentric.peak_velocity,
    rep.concentric.mean_velocity,
    rep.eccentric.peak_velocity,
    // The builder passes ROM through unrounded; a table row has no room for float noise.
    rep.rom_m === null ? null : Number(rep.rom_m.toFixed(3)),
    rep.tempo_ratio,
  ];
}

/**
 * `set_ended` swaps the per-rep objects for one table row per rep and trims
 * the set block. Every other block (VBT summary, rep-count disagreement, load
 * drift, device summaries) stays as the builder wrote it.
 */
function compactSetEnded(full: JsonObject): JsonObject {
  const { summary, set, reps, ...rest } = full;
  const compactSet = Object.fromEntries(
    Object.entries(set as JsonObject).filter(([key]) => !DROPPED_SET_FIELDS.has(key)),
  );
  return {
    summary,
    set: compactSet,
    rep_table: {
      columns: REP_TABLE_COLUMNS,
      rows: (reps as StoredRepVbt[]).map(repTableRow),
    },
    ...rest,
  };
}

const COMPACTORS: Readonly<Record<string, (full: JsonObject) => JsonObject>> = {
  rep_finalized: compactRepFinalized,
  set_ended: compactSetEnded,
};

/**
 * The compact form of one channel event. Events without a compactor, and any
 * content that is not the JSON object its builder writes, pass through as-is.
 */
export function compactChannelEvent(event: ChannelEvent): ChannelEvent {
  const compactor = COMPACTORS[event.meta.event_type];
  if (compactor === undefined) return event;
  let full: unknown;
  try {
    full = JSON.parse(event.content);
  } catch {
    return event;
  }
  if (typeof full !== 'object' || full === null) return event;
  return { meta: event.meta, content: JSON.stringify(compactor(full as JsonObject)) };
}

class CompactPushPublisher implements ChannelPublisher {
  constructor(private readonly inner: ChannelPublisher) {}

  publish(event: ChannelEvent): void {
    this.inner.publish(compactChannelEvent(event));
  }

  forSlot(slotId: string): ChannelPublisher {
    return new CompactPushPublisher(this.inner.forSlot(slotId));
  }
}

/** Wrap the connection's publisher for `detail`; `full` returns it unchanged. */
export function installPushDetail(inner: ChannelPublisher, detail: PushDetail): ChannelPublisher {
  return detail === 'full' ? inner : new CompactPushPublisher(inner);
}
