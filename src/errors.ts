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

// Own wording for both: the SDK's refusal message can carry a device status value.
const CONNECTION_REFUSED_MESSAGE =
  'The device did not accept the connection: it refused, or no one accepted the ' +
  'prompt on the device in time. Accept the connection on the device, then call ' +
  'device.connect again. The server never retries this on its own.';

const DEVICE_STATE_UNKNOWN_MESSAGE =
  'The device has not reported its current settings on this connection yet, so ' +
  'nothing was written. Wait a moment and retry; if it keeps failing, disconnect ' +
  'and reconnect the device.';

const OWN_WORDING: Readonly<Record<string, string>> = {
  CONNECTION_REFUSED: CONNECTION_REFUSED_MESSAGE,
  DEVICE_STATE_UNKNOWN: DEVICE_STATE_UNKNOWN_MESSAGE,
};

function errorCode(err: unknown): unknown {
  return err instanceof Error ? (err as { code?: unknown }).code : undefined;
}

/** The first SDK code in the error or its causes that this module words itself. */
function ownWordedCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = errorCode(current);
    if (typeof code === 'string' && code in OWN_WORDING) return code;
    current = current.cause;
  }
  return undefined;
}

export function mapSdkError(err: unknown): MappedError {
  const worded = ownWordedCode(err);
  if (worded !== undefined) {
    return { code: worded, message: OWN_WORDING[worded] };
  }
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
