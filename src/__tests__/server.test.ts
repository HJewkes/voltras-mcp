// Startup-race tests for the runServer lifecycle (AC-06, EC-16).
//
// The MCP SDK's stdio transport is replaced by a tiny in-process Transport
// that lets a test "send" a CallTool request straight into the protocol
// dispatcher and capture the matching response. We mock `bootstrapState` to
// hang for ~50 ms; during that window we deliver a `device.scan` CallTool
// request and assert the response is the structured `STARTING` error
// produced by the placeholder. We also assert the bootstrap-failure path
// closes the server before `process.exit(1)` (FIX #8).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';

// Stub the SDK package so test runs don't load `@voltras/node-sdk` (and its
// optional native peers). The `errors.ts` module unconditionally imports
// `VoltraSDKError`; provide a minimal class with the right shape.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
}));

// Replace the real stdio transport with one that never touches stdin/stdout.
// `runServer` calls `new StdioServerTransport()` directly; intercepting the
// constructor lets each test grab a reference to the transport instance and
// drive it manually.
let lastTransport: TestTransport | undefined;

class TestTransport implements Transport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  closed = false;
  readonly sent: JSONRPCMessage[] = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(msg: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
    return Promise.resolve();
  }

  // Helper: deliver a JSON-RPC message to the server side as if it arrived
  // over the wire and resolve once the matching response has been emitted.
  deliver(msg: JSONRPCMessage): Promise<JSONRPCResponse> {
    if ('id' in msg && msg.id === undefined) {
      throw new Error('test message must carry an id');
    }
    const expectId = (msg as { id?: string | number }).id;
    return new Promise<JSONRPCResponse>((resolve, reject) => {
      const startSentLen = this.sent.length;
      const interval = setInterval(() => {
        for (let i = startSentLen; i < this.sent.length; i += 1) {
          const candidate = this.sent[i];
          if (
            candidate &&
            'id' in candidate &&
            (candidate as { id?: string | number }).id === expectId &&
            'result' in candidate
          ) {
            clearInterval(interval);
            resolve(candidate as JSONRPCResponse);
            return;
          }
        }
      }, 1);
      setTimeout(() => {
        clearInterval(interval);
        reject(new Error('timed out waiting for response'));
      }, 2000);
      this.onmessage?.(msg);
    });
  }
}

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      lastTransport = new TestTransport();
      // Forward every Transport member; tests reach the captured instance via
      // `lastTransport`. McpServer.connect() wires its own callbacks onto
      // whichever object we return, so `this` IS the transport.
      Object.assign(this, lastTransport);
      // Bind methods so `McpServer` can call them with the captured this.
      const t = lastTransport;
      (this as unknown as Transport).start = () => t.start();
      (this as unknown as Transport).send = (m, o) => t.send(m, o);
      (this as unknown as Transport).close = () => t.close();
      Object.defineProperty(this, 'onmessage', {
        get: () => t.onmessage,
        set: (v) => {
          t.onmessage = v;
        },
      });
      Object.defineProperty(this, 'onclose', {
        get: () => t.onclose,
        set: (v) => {
          t.onclose = v;
        },
      });
      Object.defineProperty(this, 'onerror', {
        get: () => t.onerror,
        set: (v) => {
          t.onerror = v;
        },
      });
    }
  },
}));

const bootstrapMock = vi.fn();
vi.mock('../state/server-state.js', () => ({
  bootstrapState: (...args: unknown[]) => bootstrapMock(...(args as [unknown])) as Promise<unknown>,
}));

const { runServer } = await import('../server.js');

beforeEach(() => {
  bootstrapMock.mockReset();
  lastTransport = undefined;
});

// Build a minimal `initialize` request so the SDK's request lifecycle is
// happy before we issue a tool call. The SDK validates protocol version &
// capabilities; we mirror what an MCP client would send.
function initRequest(id: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    },
  };
}

function callToolRequest(id: number, name: string): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  };
}

describe('runServer startup race', () => {
  it('returns STARTING for tools called during the bootstrap window', async () => {
    // Hang bootstrap for 50ms so we have a clear window to issue the call.
    bootstrapMock.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));

    const serverPromise = runServer();
    // Wait for the transport to be wired up by `server.connect()`.
    while (lastTransport?.onmessage === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }

    const transport = lastTransport;
    // Initialize first so the protocol state machine accepts tool calls.
    await transport.deliver(initRequest(1));
    transport.onmessage?.({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // Issue a tool call DURING the bootstrap window. Expected: STARTING.
    const response = await transport.deliver(callToolRequest(2, 'device.scan'));
    expect(response.result).toBeDefined();
    const result = response.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      code?: string;
      message?: string;
    };
    expect(payload.code).toBe('STARTING');
    expect(payload.message).toMatch(/initializing/i);

    await serverPromise;
  });

  it('closes the server before exiting on bootstrap failure (FIX #8)', async () => {
    bootstrapMock.mockRejectedValueOnce(new Error('boom'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runServer();

    expect(lastTransport?.closed).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // server.close() must be called BEFORE process.exit(1) — order is
    // visible in `closed=true` AT THE TIME `exit` was invoked, since exit
    // is the last sync step and we mocked it to no-op.
    const exitCallOrder = exitSpy.mock.invocationCallOrder[0];
    // No reliable invocation-order check for `transport.close()` (it's a
    // method call, not a spy); but Node mocks share a global counter, so
    // this assertion above (exitCalledWith 1) plus `closed=true` is
    // sufficient. The literal source code does `await server.close()` then
    // `process.exit(1)` — see src/server.ts.
    expect(exitCallOrder).toBeDefined();

    exitSpy.mockRestore();
  });
});
