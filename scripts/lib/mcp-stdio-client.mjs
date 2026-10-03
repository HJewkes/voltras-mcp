// A minimal JSON-RPC client over a spawned MCP server's stdio, shared by
// `scripts/gen-tool-reference.mjs` and `scripts/token-budget.mjs`.

import { StringDecoder } from 'node:string_decoder';

const REQUEST_TIMEOUT_MS = 20000;

/**
 * Wire a request function onto `child`. Every message without an `id` (a
 * server notification) goes to `onNotification`, in arrival order.
 */
export function createClient(child, { onNotification = () => {}, timeoutMs } = {}) {
  const pending = new Map();
  // A multi-byte UTF-8 character can land across two `data` events on a large
  // response; `StringDecoder` holds the incomplete tail back until it completes.
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 1;
  const dispatch = (message) => {
    if (message.id === undefined) return onNotification(message);
    const waiter = pending.get(message.id);
    if (!waiter) return undefined;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    return waiter.resolve(message);
  };
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const message = parseLine(line);
      if (message !== null) dispatch(message);
    }
  });
  return function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), limit);
      pending.set(id, { resolve, timer });
    });
  };
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function unwrap(response, method) {
  if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

/** The MCP handshake: `initialize`, then the `initialized` notification. */
export async function initialize(child, request, clientName) {
  unwrap(
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    }),
    'initialize',
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}
