// Tiny level-gated logger. Every src/ module that logs imports `log` from
// here instead of touching `console` directly so that:
//   1. stdio stays reserved for the MCP transport (no `console.log`),
//   2. log volume is governed by `config.logLevel`.
//
// `configureLogger(config)` is called once during bootstrap. Until then the
// logger defaults to 'info'. Both `debug` and `info` route through
// `console.warn` to comply with the `no-console` lint rule
// (only warn/error are allowed).

import type { Config } from './config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let _level: number = LEVELS.info;

export function configureLogger(c: Config): void {
  _level = LEVELS[c.logLevel];
}

export const log = {
  debug: (msg: string, ...args: unknown[]): void => {
    if (_level <= 0) console.warn('[DEBUG]', msg, ...args);
  },
  info: (msg: string, ...args: unknown[]): void => {
    if (_level <= 1) console.warn('[INFO]', msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    if (_level <= 2) console.warn('[WARN]', msg, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    if (_level <= 3) console.error('[ERROR]', msg, ...args);
  },
};
