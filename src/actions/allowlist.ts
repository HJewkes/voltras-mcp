// What the dashboard's action layer may run, and at which risk tier (VW-502).
//
// The tiers are the chat design's W0 to W4. This module ships W1 and W2 only:
//
//   W1  self-report, one tap, writes at once, reversible by writing again
//   W2  a plan or goal decision — a review screen states the consequence in
//       the tool's own words, then one confirm
//   W3  device, between sets only. NOT here: a device action needs the
//       single-writer lease under the dashboard's own client id, which this
//       layer does not take
//   W4  coach or voice only. Never on a touch surface, and `POST
//       /api/actions/:name` answers 403 for every one of them
//
// An unknown name answers 403, not 404, so a caller probing the layer learns
// nothing about which names exist.
//
// ── What "store-only" means here, exactly ────────────────────────────────
//
// `allowlist.test.ts` asserts every entry's namespace is one of the
// store-writing namespaces and none is a device namespace. That is a NAMESPACE
// check, not a proof that a handler touches no device: it guards the allowlist
// against rotting open as tools are added, and it is not a semantic guarantee.
// The semantic claim rests on reading the four handlers, which is a review
// step, not a test.

/** Risk tier, from the chat design's write-path table. */
export type ActionTier = 'W1' | 'W2';

export interface ActionEntry {
  /** The MCP tool whose schema and handler run. */
  readonly tool: string;
  readonly tier: ActionTier;
  /** One line a reviewer can check the tier against. */
  readonly why: string;
}

/**
 * Namespaces an allowlisted tool may live in. Everything that drives hardware
 * is absent, and its absence is what the test checks.
 */
export const STORE_ONLY_NAMESPACES = ['profile', 'goal', 'plan', 'session'] as const;

/** Namespaces no allowlist entry may ever name. */
export const DEVICE_NAMESPACES = [
  'device',
  'slot',
  'bilateral',
  'isometric',
  'system',
  'debug',
  'mock',
  'timer',
] as const;

/**
 * The allowlist. The key is the action name the client posts; the value names
 * the tool that actually runs, so the two can diverge later (a rename, a
 * flow-specific alias) without breaking a client.
 */
export const ACTION_ALLOWLIST: Readonly<Record<string, ActionEntry>> = {
  'profile.log_bodyweight': {
    tool: 'profile.log_bodyweight',
    tier: 'W1',
    why: 'A reading at the same measuredAt replaces the previous one, so a repeat is a correction.',
  },
  'profile.log_weekly_checkin': {
    tool: 'profile.log_weekly_checkin',
    tier: 'W1',
    why: 'One check-in per week; a later call is the correction.',
  },
  'session.checkin': {
    tool: 'session.checkin',
    tier: 'W1',
    why: 'Per-session self-report. Additive, and reversible by reporting again.',
  },
  'goal.accept_target': {
    tool: 'goal.accept_target',
    tier: 'W2',
    why: 'Cannot be undone (GOAL_TARGET_FIXED). The review screen names the two exits.',
  },
  'goal.weekly_review': {
    tool: 'goal.weekly_review',
    tier: 'W2',
    why: 'Keyed by weekOf, so an answer replaces rather than duplicates.',
  },
  'plan.week.skip': {
    tool: 'plan.week.skip',
    tier: 'W2',
    why: 'Append-only history; a repeat answers WEEK_ALREADY_SKIPPED.',
  },
  'profile.respond_recomp_advisory': {
    tool: 'profile.respond_recomp_advisory',
    tier: 'W2',
    why: 'Records an answer to a standing advisory. A later answer is the correction.',
  },
  'profile.set_diet_phase': {
    tool: 'profile.set_diet_phase',
    tier: 'W2',
    why: 'A past-dated phase rewrites the timeline, so the review screen shows the result first.',
  },
};

/**
 * Deliberately absent, so a reader does not have to guess whether they were
 * forgotten. Each needs something this PR does not build.
 */
export const DEFERRED_ACTIONS: Readonly<Record<string, string>> = {
  'goal.retire':
    'A retired proposal is never re-offered and a mistaken retry cannot be undone. It needs ' +
    'a review screen this layer does not yet have.',
  'session.mark_kind': 'The tool does not exist yet (VW-489).',
};

/** The allowlist entry for `name`, or `undefined` when it is not allowed. */
export function actionEntry(name: string): ActionEntry | undefined {
  return Object.prototype.hasOwnProperty.call(ACTION_ALLOWLIST, name)
    ? ACTION_ALLOWLIST[name]
    : undefined;
}

/** The namespace of a dotted tool name — `profile.log_bodyweight` is `profile`. */
export function toolNamespace(tool: string): string {
  return tool.split('.')[0];
}
