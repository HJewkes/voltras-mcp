// Configuration loader for voltras-mcp.
//
// Reads the three runtime env vars that govern the entire server:
//   - VOLTRA_ADAPTER  (R7) — 'mock' | 'node', default 'node'.
//   - VMCP_DB_PATH    (R8) — sqlite path, default ~/.voltras/vmcp.sqlite.
//   - VMCP_LOG_LEVEL        — 'debug' | 'info' | 'warn' | 'error', default 'info'.
//
// `loadConfig()` is a pure function: it neither logs nor touches disk. It
// throws synchronously when VOLTRA_ADAPTER is set to an unrecognized value so
// the failure surfaces before bootstrapState begins.

import { homedir } from 'node:os';

export type AdapterKind = 'mock' | 'node';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  readonly adapter: AdapterKind;
  readonly dbPath: string;
  readonly logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.VOLTRA_ADAPTER ?? 'node';
  if (raw !== 'mock' && raw !== 'node') {
    throw new Error(`Invalid VOLTRA_ADAPTER="${raw}". Must be "mock" or "node".`);
  }
  // HOME is normally set on every supported platform but is typed as
  // possibly-undefined; fall back to os.homedir() when absent.
  const home = env.HOME ?? homedir();
  return Object.freeze({
    adapter: raw,
    dbPath: env.VMCP_DB_PATH ?? `${home}/.voltras/vmcp.sqlite`,
    logLevel: (env.VMCP_LOG_LEVEL as LogLevel | undefined) ?? 'info',
  }) satisfies Config;
}
