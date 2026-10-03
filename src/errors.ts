// Maps thrown values from the Voltra SDK (or anywhere else) into a
// `{ code, message }` pair safe for tool clients. Stack traces and other
// internal details are routed to `log.debug` per AC-23 / R23 — they must
// never appear in user-facing output.

import { VoltraSDKError, type ErrorCodeType } from '@voltras/node-sdk';
import { log } from './logger.js';

export interface MappedError {
  code: string;
  message: string;
  /** The input field a refusal points at, when the thrower named one. */
  field?: string;
}

// Codes whose SDK message is one fixed string at every SDK throw site, so it
// can reach the client as is. Every other SDK message can interpolate an inner
// error or a device status value, so it goes to log.debug and never further.
const SAFE_SDK_CODES: ReadonlySet<string> = new Set<ErrorCodeType>([
  // Only ever thrown with the class's default "Device is not connected".
  'NOT_CONNECTED',
  // One throw site, with the fixed "Already connected to a device".
  'ALREADY_CONNECTED',
]);

type SafeSdkCode = 'NOT_CONNECTED' | 'ALREADY_CONNECTED';

const RECONNECT = 'Retry; if it keeps failing, disconnect and reconnect the device.';
const RESTART_AND_CONNECT = 'Turn the device off and on, then call device.connect again.';

// Both win even when an outer connect failure wraps them as its cause.
const CONNECTION_REFUSED_MESSAGE =
  'The device did not accept the connection: it refused, or no one accepted the ' +
  'prompt on the device in time. Accept the connection on the device, then call ' +
  'device.connect again. The server never retries this on its own.';

const DEVICE_STATE_UNKNOWN_MESSAGE =
  'The device has not reported its current settings on this connection yet, so ' +
  'nothing was written. Wait a moment and retry; if it keeps failing, disconnect ' +
  'and reconnect the device.';

const CAUSE_WORDING: Readonly<Record<string, string>> = {
  CONNECTION_REFUSED: CONNECTION_REFUSED_MESSAGE,
  DEVICE_STATE_UNKNOWN: DEVICE_STATE_UNKNOWN_MESSAGE,
};

const GENERIC_SDK_MESSAGE = `The device reported an error. ${RECONNECT}`;

const OWN_WORDING: Readonly<Record<Exclude<ErrorCodeType, SafeSdkCode>, string>> = {
  CONNECTION_REFUSED: CONNECTION_REFUSED_MESSAGE,
  DEVICE_STATE_UNKNOWN: DEVICE_STATE_UNKNOWN_MESSAGE,
  CONNECTION_FAILED:
    'Could not connect to the device. Check it is on and nearby, then call device.connect again.',
  CONNECTION_LOST: 'The connection to the device dropped. Call device.connect, then retry.',
  CONNECTION_TIMEOUT:
    'The device did not answer in time while connecting. Check it is on and nearby, then ' +
    'call device.connect again.',
  AUTH_FAILED: `The device did not complete the connection handshake. ${RESTART_AND_CONNECT}`,
  AUTH_TIMEOUT: `The device did not finish the connection handshake in time. ${RESTART_AND_CONNECT}`,
  AUTH_INVALID_RESPONSE: `The device answered the connection handshake unexpectedly. ${RESTART_AND_CONNECT}`,
  BLUETOOTH_UNAVAILABLE: 'Bluetooth is not available on this computer. Turn it on, then try again.',
  BLUETOOTH_PERMISSION_DENIED:
    'This app does not have Bluetooth permission. Allow it in the system privacy settings, ' +
    'then try again.',
  BLUETOOTH_ADAPTER_ERROR:
    "The computer's Bluetooth adapter reported an error. Turn Bluetooth off and on, then try again.",
  DEVICE_NOT_FOUND:
    'No device was found. Check it is on, nearby and not connected elsewhere, then call ' +
    'device.scan again.',
  DEVICE_DISCONNECTED: 'The device disconnected. Call device.connect, then retry.',
  COMMAND_FAILED: `The device did not accept the command, so the setting may not have changed. ${RECONNECT}`,
  COMMAND_TIMEOUT: `The device did not answer the command in time, so the setting may not have changed. ${RECONNECT}`,
  INVALID_SETTING:
    'The device does not support that setting value. Choose a supported value and retry.',
  TELEMETRY_DECODE_ERROR: `The device sent live data the server could not read. ${RECONNECT}`,
  TIMEOUT: `The device did not answer in time. ${RECONNECT}`,
  UNKNOWN: GENERIC_SDK_MESSAGE,
};

function errorCode(err: unknown): unknown {
  return err instanceof Error ? (err as { code?: unknown }).code : undefined;
}

/** The first code in the error or its causes that is worded the same wherever it sits. */
function causeWordedCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = errorCode(current);
    if (typeof code === 'string' && code in CAUSE_WORDING) return code;
    current = current.cause;
  }
  return undefined;
}

function sdkMessage(err: VoltraSDKError): string {
  if (SAFE_SDK_CODES.has(err.code)) return err.message;
  log.debug('sdk error', err.code, err.message);
  return (OWN_WORDING as Readonly<Record<string, string>>)[err.code] ?? GENERIC_SDK_MESSAGE;
}

export function mapSdkError(err: unknown): MappedError {
  const worded = causeWordedCode(err);
  if (worded !== undefined) {
    return { code: worded, message: CAUSE_WORDING[worded] };
  }
  if (err instanceof VoltraSDKError) {
    return { code: err.code, message: sdkMessage(err) };
  }
  if (err instanceof Error) {
    const code =
      'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    log.debug('unhandled error', err.message, err.stack);
    const field = (err as { field?: unknown }).field;
    return typeof field === 'string'
      ? { code, message: err.message, field }
      : { code, message: err.message };
  }
  return { code: 'UNKNOWN', message: String(err) };
}
