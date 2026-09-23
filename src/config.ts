// Configuration loader for voltras-mcp.
//
// Reads the runtime env vars that govern the entire server:
//   - VOLTRA_ADAPTER             (R7) — 'mock' | 'node', default 'node'.
//   - VMCP_DB_PATH               (R8) — sqlite path, default ~/.voltras/vmcp.sqlite.
//   - VMCP_SLOT_BINDINGS_PATH         — slot-bindings JSON, default ~/.voltras/slot-bindings.json.
//   - VMCP_LOG_LEVEL                  — 'debug' | 'info' | 'warn' | 'error', default 'info'.
//   - VMCP_REP_SOURCE                  — 'analytics' | 'firmware', default 'analytics'.
//   - VMCP_REST_TIMER                  — 'on' | 'off', default 'off'.
//   - VMCP_REP_CORRECTIONS             — 'on' | 'off', both halves together, no default.
//   - VMCP_REP_UNRACK_DROP             — 'on' | 'off', default 'off'.
//   - VMCP_REP_ECC_TRUNCATE            — 'on' | 'off', default 'on'.
//   - VMCP_CUES                        — 'on' | 'off', default 'off'.
//   - VMCP_CUES_MIDSET                 — 'on' | 'off', default 'off'.
//   - VMCP_AUTO_ARM                    — 'on' | 'off', default 'on'.
//   - VOLTRAS_EFFORT_CUE               — 'on' | 'off', default 'off'.
//   - VMCP_TRUECOACH_OUTBOX            — 'on' | 'off', default 'off'.
//   - VMCP_TRUECOACH_OUTBOX_DIR        — outbox root, default ~/.voltras/truecoach-outbox.
//   - VMCP_TRUECOACH_SUBMIT_ON_END     — 'on' | 'off', default 'off'.
//   - VMCP_TRUECOACH_*                 — read-only TrueCoach pull, see TrueCoachConfig.
//   - VMCP_MOUNT_RATING_LBS            — the anchor's pull-out load rating, in
//     pounds; unset (default) means the rating is UNKNOWN, not unlimited (VW-274).
//
// `loadConfig()` is a pure function: it neither logs nor touches disk. It
// throws synchronously when VOLTRA_ADAPTER, VMCP_REP_SOURCE, VMCP_REST_TIMER,
// VMCP_REP_CORRECTIONS, VMCP_REP_UNRACK_DROP, VMCP_REP_ECC_TRUNCATE,
// VMCP_AUTO_ARM, VOLTRAS_EFFORT_CUE or VMCP_MOUNT_RATING_LBS is set to an unrecognized value so the
// failure surfaces before bootstrapState begins. VMCP_TRUECOACH_OUTBOX throws
// on the same terms.

import { homedir } from 'node:os';

export type AdapterKind = 'mock' | 'node';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Which rep pipeline the consumer read boundary draws from (VMCP-02.29 PR5).
 *   - `'analytics'` (DEFAULT) — the workout-analytics-derived `ActiveSet.reps`,
 *     the only behavior shipped through PR4. Every consumer stays byte-for-byte
 *     identical to pre-PR5 when this is selected.
 *   - `'firmware'` — the firmware-anchored `ActiveSet.firmwareReps` (each
 *     `enriched` Rep), gated behind this dark flag until the PR6 hardware
 *     cutover flips the default.
 */
export type RepSource = 'analytics' | 'firmware';

/**
 * Whether `finalizeSet` auto-arms the passive `rest_status` emission cycle
 * (VMCP-02.08) when a set closes (VMCP-02.54).
 *   - `'off'` (DEFAULT) — no auto rest timer. The set closes with its
 *     `set_ended` push and nothing further; a consumer that wants rest
 *     coaching drives it explicitly via the `timer.*` tools. Opt-in by
 *     design: the automatic 5-minute `rest_status` stream was channel noise
 *     for callers that don't consume it, and semantically wrong on paths
 *     like `session.end` where the owning session is already torn down.
 *   - `'on'` — auto-arm on every natural set close. Still skipped when the
 *     close is a `session_end` cascade (the session no longer exists).
 */
export type RestTimerMode = 'off' | 'on';

/**
 * The legacy coarse switch over BOTH movement-class-dependent rep-segmentation
 * corrections (VMCP-02.66 un-rack drop + VMCP-02.65 eccentric idle-tail
 * truncation). It has no default of its own any more: unset, each half falls
 * back to its own variable. Set explicitly, it moves both halves together, so
 * an existing `VMCP_REP_CORRECTIONS=off` is still a complete opt-out and
 * `=on` still turns both on.
 */
export type RepCorrectionsMode = 'off' | 'on';

/**
 * Whether `finalizeSet` drops the un-rack artifact rep (VMCP-02.66) — the
 * phantom whose concentric nets negative displacement.
 *   - `'off'` (DEFAULT) — skipped. It rests on a bench-observed assumption (a
 *     valid concentric nets positive position) validated on press/row only; on
 *     an untested movement class it could silently drop a valid rep, and it
 *     changes the persisted rep COUNT. Kept dark until the VW-16 bench parity
 *     run confirms it across movement classes.
 *   - `'on'` — drop the artifact. Runs before VMCP-02.65 so the truncation sees
 *     a de-artifacted array.
 */
export type RepUnrackDropMode = 'off' | 'on';

/**
 * Whether `finalizeSet` truncates the final rep's eccentric idle tail
 * (VMCP-02.65).
 *   - `'on'` (DEFAULT) — trim the parked-cable samples that land on the last
 *     rep's eccentric. It deletes no rep and rewrites no raw sample; it moves
 *     only that rep's derived `tempo_ratio` and eccentric mean velocity, which
 *     are known wrong without it. Decided independently of VW-16.
 *   - `'off'` — leave the idle tail on the phase.
 *
 * The VMCP-02.69a peak recompute and VMCP-02.64 derived-VBT persistence are
 * gated by neither flag: they carry no movement-class dependence and always run.
 */
export type RepEccentricTruncateMode = 'off' | 'on';

function onOffFlag(raw: string | undefined, name: string, fallback: 'off' | 'on'): 'off' | 'on' {
  const value = raw ?? fallback;
  if (value !== 'off' && value !== 'on') {
    throw new Error(`Invalid ${name}="${value}". Must be "off" or "on".`);
  }
  return value;
}

/**
 * Whether the server speaks deterministic coaching cues off channel events
 * (VMCP-02.79) — set intros, target-hit / slowdown / set-complete prompts —
 * instead of relying on the model to generate them on the fly.
 *   - `'off'` (DEFAULT) — no automatic spoken cues; the model drives all TTS
 *     via `system.speak`. Opt-in by design: cues are audible, and event-timed
 *     cues would double up with model-generated ones until the PT skill is
 *     told to cede those categories.
 *   - `'on'` — the CueTeePublisher speaks templated cues at the instant the
 *     triggering event fires. Independently a no-op on non-macOS hosts (cues
 *     route through the macOS `say` binary).
 */
export type CuesMode = 'off' | 'on';

/**
 * Whether `target_hit` / `slowdown` cues are allowed to fire (VMCP-05.01).
 * Both categories can land mid-set, while the lifter is still under load —
 * unlike `set_intro`/`set_complete`, which only fire at set boundaries. Every
 * cue mutes the mic for its `say` duration (~2s), and that mute discards
 * frames outright rather than buffering them, so the ungated voice "stop"
 * fast-path is unavailable for that window. Gating mid-set cues off by
 * default keeps that blind spot out of the riskiest part of a set — under
 * load, mid-rep — without losing the safe-boundary cues.
 *   - `'off'` (DEFAULT) — only `set_intro`/`set_complete` cues speak, when
 *     `VMCP_CUES='on'`. No cue plays while more reps are still expected.
 *   - `'on'` — all four categories speak. Opt in only when a spotter or
 *     other physical backstop is present, or for supervised/controlled
 *     sets (e.g. filming) where the bounded per-cue mute window is
 *     acceptable.
 */
export type CuesMidSetMode = 'off' | 'on';

/**
 * Whether the bridge opens a set on its own when an idle-arm rep lands while
 * a session is active and no set is (VW-164).
 *   - `'on'` (DEFAULT) — the first idle rep auto-arms a set and is counted as
 *     its rep 1. Reps start within ~1s of a weight change on the unit, and the
 *     2026-09-07 dogfood lost 2-5 reps per set to the gap between the lifter
 *     starting and `set.start` arriving (30+ `idle_rep_summary` events).
 *   - `'off'` — idle reps only surface as `idle_rep_summary` / `idle_rep`
 *     coaching signals, as before. For flows that want every set to be an
 *     explicit `set.start`.
 */
export type AutoArmMode = 'off' | 'on';

/**
 * Which rule decides the mid-set ending cue (VW-448 slice 7).
 *   - `'off'` (DEFAULT) — the watch's own triggers, evaluated exactly as before.
 *   - `'on'` — the effort resolver: at most one of `set_target_reached`,
 *     `velocity_loss_exceeded` or `effort_target_reached` per set, and a cue record
 *     stored with the set. Turned on by default only after the bench (slice 8).
 */
export type EffortCueMode = 'off' | 'on';

/**
 * Whether `session.end` drops the session's rendered coach results into the
 * local outbox directory (`src/integrations/truecoach/outbox.ts`).
 *   - `'off'` (DEFAULT) — nothing is written. `report.session_results` still
 *     renders on demand; this flag only governs the automatic file drop.
 *   - `'on'` — one JSON file per ended session under
 *     `<VMCP_TRUECOACH_OUTBOX_DIR>/pending/`. Local only: the file is written
 *     for a human to read or paste, and nothing in this repo uploads it.
 */
export type TrueCoachOutboxMode = 'off' | 'on';

/**
 * Whether writing an outbox entry also spawns `tools/truecoach-submit` to post
 * it (`VMCP_TRUECOACH_SUBMIT_ON_END`).
 *   - `'off'` (DEFAULT) — nothing is spawned. The file is the end of the line.
 *   - `'on'` — one detached `truecoach-submit --submit --session <id>` per
 *     written entry, once, with no retry and no polling. Requires
 *     `VMCP_TRUECOACH_OUTBOX=on` (there is no entry to submit otherwise) and a
 *     browser profile the human has already signed in. That tool interacts
 *     with TrueCoach, which its terms forbid without written consent — read
 *     `tools/truecoach-submit/README.md` before turning this on.
 */
export type TrueCoachSubmitOnEndMode = 'off' | 'on';

/**
 * Credentials and paths for the read-only TrueCoach pull (`truecoach.import_week`).
 *
 * Every field is optional and every field is absent by default: with no
 * credentials the tool returns `NOT_CONFIGURED` and makes no network call. The
 * server never prompts for these and never logs them — see `redact.ts`.
 *
 *   - `VMCP_TRUECOACH_USERNAME`     — the account email.
 *   - `VMCP_TRUECOACH_PASSWORD`     — the password, in plaintext in the env.
 *   - `VMCP_TRUECOACH_PASSWORD_CMD` — a shell command whose stdout is the
 *     password, so the secret can live in the macOS keychain instead. Takes
 *     precedence over `VMCP_TRUECOACH_PASSWORD` when both are set.
 *   - `VMCP_TRUECOACH_CLIENT_ID`    — override for the client id; when absent
 *     the `user_id` from the token response is used.
 *   - `VMCP_TRUECOACH_TOKEN_PATH`   — on-disk access-token cache (mode 0600).
 *   - `VMCP_TRUECOACH_CACHE_DIR`    — on-disk raw-response cache.
 */
export interface TrueCoachConfig {
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly passwordCommand: string | undefined;
  readonly clientId: string | undefined;
  readonly tokenPath: string;
  readonly cacheDir: string;
}

export interface Config {
  readonly adapter: AdapterKind;
  readonly dbPath: string;
  readonly slotBindingsPath: string;
  readonly logLevel: LogLevel;
  readonly repSource: RepSource;
  readonly restTimer: RestTimerMode;
  readonly repUnrackDrop: RepUnrackDropMode;
  readonly repEccentricTruncate: RepEccentricTruncateMode;
  readonly cues: CuesMode;
  readonly cuesMidSet: CuesMidSetMode;
  readonly autoArm: AutoArmMode;
  readonly effortCue: EffortCueMode;
  readonly trueCoachOutbox: TrueCoachOutboxMode;
  readonly trueCoachOutboxDir: string;
  readonly trueCoachSubmitOnEnd: TrueCoachSubmitOnEndMode;
  readonly trueCoach: TrueCoachConfig;
  /**
   * The mount's pull-out load rating in pounds (VW-274), or `undefined` when
   * unconfigured. No mount rating is published by Beyond Power for any of
   * its accessories, so `undefined` means UNKNOWN, never "no limit" — a tool
   * gating on it must say the envelope is unknown, not treat the load as safe.
   */
  readonly mountRatingLbs: number | undefined;
}

function loadTrueCoachConfig(env: NodeJS.ProcessEnv, home: string): TrueCoachConfig {
  return Object.freeze({
    username: env.VMCP_TRUECOACH_USERNAME,
    password: env.VMCP_TRUECOACH_PASSWORD,
    passwordCommand: env.VMCP_TRUECOACH_PASSWORD_CMD,
    clientId: env.VMCP_TRUECOACH_CLIENT_ID,
    tokenPath: env.VMCP_TRUECOACH_TOKEN_PATH ?? `${home}/.voltras/truecoach-token.json`,
    cacheDir: env.VMCP_TRUECOACH_CACHE_DIR ?? `${home}/.voltras/truecoach-cache`,
  }) satisfies TrueCoachConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.VOLTRA_ADAPTER ?? 'node';
  if (raw !== 'mock' && raw !== 'node') {
    throw new Error(`Invalid VOLTRA_ADAPTER="${raw}". Must be "mock" or "node".`);
  }
  const repSource = env.VMCP_REP_SOURCE ?? 'analytics';
  if (repSource !== 'analytics' && repSource !== 'firmware') {
    throw new Error(`Invalid VMCP_REP_SOURCE="${repSource}". Must be "analytics" or "firmware".`);
  }
  const restTimer = env.VMCP_REST_TIMER ?? 'off';
  if (restTimer !== 'off' && restTimer !== 'on') {
    throw new Error(`Invalid VMCP_REST_TIMER="${restTimer}". Must be "off" or "on".`);
  }
  // The coarse flag no longer carries a default of its own: when it is set it
  // still moves both halves together, and when it is absent each half falls
  // back to its own default (VMCP-02.65 on, VMCP-02.66 off behind VW-16).
  const bothHalves =
    env.VMCP_REP_CORRECTIONS === undefined
      ? undefined
      : onOffFlag(env.VMCP_REP_CORRECTIONS, 'VMCP_REP_CORRECTIONS', 'off');
  const repUnrackDrop = onOffFlag(
    env.VMCP_REP_UNRACK_DROP,
    'VMCP_REP_UNRACK_DROP',
    bothHalves ?? 'off',
  );
  const repEccentricTruncate = onOffFlag(
    env.VMCP_REP_ECC_TRUNCATE,
    'VMCP_REP_ECC_TRUNCATE',
    bothHalves ?? 'on',
  );
  const cues = env.VMCP_CUES ?? 'off';
  if (cues !== 'off' && cues !== 'on') {
    throw new Error(`Invalid VMCP_CUES="${cues}". Must be "off" or "on".`);
  }
  const cuesMidSet = env.VMCP_CUES_MIDSET ?? 'off';
  if (cuesMidSet !== 'off' && cuesMidSet !== 'on') {
    throw new Error(`Invalid VMCP_CUES_MIDSET="${cuesMidSet}". Must be "off" or "on".`);
  }
  const autoArm = env.VMCP_AUTO_ARM ?? 'on';
  if (autoArm !== 'off' && autoArm !== 'on') {
    throw new Error(`Invalid VMCP_AUTO_ARM="${autoArm}". Must be "off" or "on".`);
  }
  const trueCoachOutbox = env.VMCP_TRUECOACH_OUTBOX ?? 'off';
  if (trueCoachOutbox !== 'off' && trueCoachOutbox !== 'on') {
    throw new Error(`Invalid VMCP_TRUECOACH_OUTBOX="${trueCoachOutbox}". Must be "off" or "on".`);
  }
  const trueCoachSubmitOnEnd = env.VMCP_TRUECOACH_SUBMIT_ON_END ?? 'off';
  if (trueCoachSubmitOnEnd !== 'off' && trueCoachSubmitOnEnd !== 'on') {
    throw new Error(
      `Invalid VMCP_TRUECOACH_SUBMIT_ON_END="${trueCoachSubmitOnEnd}". Must be "off" or "on".`,
    );
  }
  const effortCue = onOffFlag(env.VOLTRAS_EFFORT_CUE, 'VOLTRAS_EFFORT_CUE', 'off');
  const mountRatingLbs = parseMountRatingLbs(env.VMCP_MOUNT_RATING_LBS);
  // HOME is normally set on every supported platform but is typed as
  // possibly-undefined; fall back to os.homedir() when absent.
  const home = env.HOME ?? homedir();
  return Object.freeze({
    adapter: raw,
    dbPath: env.VMCP_DB_PATH ?? `${home}/.voltras/vmcp.sqlite`,
    slotBindingsPath: env.VMCP_SLOT_BINDINGS_PATH ?? `${home}/.voltras/slot-bindings.json`,
    logLevel: (env.VMCP_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    repSource,
    restTimer,
    repUnrackDrop,
    repEccentricTruncate,
    cues,
    cuesMidSet,
    autoArm,
    effortCue,
    trueCoachOutbox,
    trueCoachOutboxDir: env.VMCP_TRUECOACH_OUTBOX_DIR ?? `${home}/.voltras/truecoach-outbox`,
    trueCoachSubmitOnEnd,
    trueCoach: loadTrueCoachConfig(env, home),
    mountRatingLbs,
  }) satisfies Config;
}

/** `undefined` when unset; throws on anything that is not a positive finite number. */
function parseMountRatingLbs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid VMCP_MOUNT_RATING_LBS="${raw}". Must be a positive number.`);
  }
  return value;
}
