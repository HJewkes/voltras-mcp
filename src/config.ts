// Configuration loader for voltras-mcp.
//
// Reads the runtime env vars that govern the entire server:
//   - VOLTRA_ADAPTER             (R7) — 'mock' | 'node', default 'node'.
//   - VMCP_DB_PATH               (R8) — sqlite path, default ~/.voltras/vmcp.sqlite.
//   - VMCP_SLOT_BINDINGS_PATH         — slot-bindings JSON, default ~/.voltras/slot-bindings.json.
//   - VMCP_LOG_LEVEL                  — 'debug' | 'info' | 'warn' | 'error', default 'info'.
//   - VMCP_REP_SOURCE                  — 'analytics' | 'firmware', default 'analytics'.
//   - VMCP_REST_TIMER                  — 'on' | 'off', default 'off'.
//   - VMCP_REP_CORRECTIONS             — 'on' | 'off', default 'off'.
//   - VMCP_CUES                        — 'on' | 'off', default 'off'.
//
// `loadConfig()` is a pure function: it neither logs nor touches disk. It
// throws synchronously when VOLTRA_ADAPTER, VMCP_REP_SOURCE, VMCP_REST_TIMER, or
// VMCP_REP_CORRECTIONS is set to an unrecognized value so the failure surfaces
// before bootstrapState begins.

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
 * Whether `finalizeSet` applies the movement-class-dependent rep-segmentation
 * corrections at set close (VMCP-02.66 un-rack drop + VMCP-02.65 eccentric
 * idle-tail truncation).
 *   - `'off'` (DEFAULT) — those two corrections are skipped. They rest on a
 *     bench-observed assumption (a valid concentric nets positive position) and
 *     a tunable idle threshold that are only validated on press/row so far; on
 *     an untested movement class the un-rack filter could silently drop valid
 *     reps. Kept dark until the VW-16 bench parity run confirms them across
 *     movement classes, mirroring the VMCP_REP_SOURCE cutover pattern.
 *   - `'on'` — apply both corrections. The VMCP-02.69a signed-peak recompute
 *     and VMCP-02.64 derived-VBT persistence are NOT gated by this flag; they
 *     carry no movement-class dependence and always run.
 */
export type RepCorrectionsMode = 'off' | 'on';

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

export interface Config {
  readonly adapter: AdapterKind;
  readonly dbPath: string;
  readonly slotBindingsPath: string;
  readonly logLevel: LogLevel;
  readonly repSource: RepSource;
  readonly restTimer: RestTimerMode;
  readonly repCorrections: RepCorrectionsMode;
  readonly cues: CuesMode;
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
  const repCorrections = env.VMCP_REP_CORRECTIONS ?? 'off';
  if (repCorrections !== 'off' && repCorrections !== 'on') {
    throw new Error(`Invalid VMCP_REP_CORRECTIONS="${repCorrections}". Must be "off" or "on".`);
  }
  const cues = env.VMCP_CUES ?? 'off';
  if (cues !== 'off' && cues !== 'on') {
    throw new Error(`Invalid VMCP_CUES="${cues}". Must be "off" or "on".`);
  }
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
    repCorrections,
    cues,
  }) satisfies Config;
}
