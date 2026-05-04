// Maps thrown values from the Voltra SDK (or anywhere else) into a
// `{ code, message }` pair safe for tool clients. Stack traces and other
// internal details are routed to `log.debug` per AC-23 / R23 — they must
// never appear in user-facing output.

import { VoltraSDKError } from '@voltras/node-sdk';
import { log } from './logger.js';

export interface MappedError {
  code: string;
  message: string;
}

export function mapSdkError(err: unknown): MappedError {
  if (err instanceof VoltraSDKError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    const code =
      'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    log.debug('unhandled error', err.message, err.stack);
    return { code, message: err.message };
  }
  return { code: 'UNKNOWN', message: String(err) };
}
