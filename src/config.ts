// Configuration loader for voltras-mcp.
//
// Reads the runtime env vars that govern the entire server:
//   - VOLTRA_ADAPTER             (R7) — 'mock' | 'node', default 'node'.
//   - VMCP_DB_PATH               (R8) — sqlite path, default ~/.voltras/vmcp.sqlite.
//   - VMCP_SLOT_BINDINGS_PATH         — slot-bindings JSON, default ~/.voltras/slot-bindings.json.
//   - VMCP_LOG_LEVEL                  — 'debug' | 'info' | 'warn' | 'error', default 'info'.
//   - VMCP_REP_SOURCE                  — 'analytics' | 'firmware', default 'analytics'.
//
// `loadConfig()` is a pure function: it neither logs nor touches disk. It
// throws synchronously when VOLTRA_ADAPTER or VMCP_REP_SOURCE is set to an
// unrecognized value so the failure surfaces before bootstrapState begins.

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

export interface Config {
  readonly adapter: AdapterKind;
  readonly dbPath: string;
  readonly slotBindingsPath: string;
  readonly logLevel: LogLevel;
  readonly repSource: RepSource;
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
  // HOME is normally set on every supported platform but is typed as
  // possibly-undefined; fall back to os.homedir() when absent.
  const home = env.HOME ?? homedir();
  return Object.freeze({
    adapter: raw,
    dbPath: env.VMCP_DB_PATH ?? `${home}/.voltras/vmcp.sqlite`,
    slotBindingsPath: env.VMCP_SLOT_BINDINGS_PATH ?? `${home}/.voltras/slot-bindings.json`,
    logLevel: (env.VMCP_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    repSource,
  }) satisfies Config;
}
