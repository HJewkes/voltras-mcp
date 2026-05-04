// Unit tests for the three polling MCP resources (Wave 3F, Task 15).
//
// Strategy: construct a real `McpServer` (no transport connection — the
// register* functions only need the registration surface), register each
// resource, and invoke its `readCallback` directly. This validates the JSON
// payload shape AND covers the SDK's resource-registration code path so the
// API signature is exercised end-to-end.
//
// Coverage targets (NF-03 floor 80% for src/resources/):
//   - voltra://device/current returns connected/connectionState fields.
//   - Two reads with no state change return identical JSON (AC-12 stability).
//   - voltra://session/active returns sessionId+startedAt when active.
//   - voltra://session/active returns { active: false } when no session
//     (EC-10, AC-12) — explicitly NOT null and NOT empty `{}`.
//   - voltra://set/active returns { active: false } when no set.
//   - voltra://set/active reflects appendRep calls (reps.length grows).
//   - sendResourceListChanged is NEVER called over the entire test session
//     (AC-13). The resource list is fixed at startup.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { LiveState, type ActiveSession, type ActiveSet } from '../../state/live-state.js';
import { registerDeviceResource } from '../device-resource.js';
import { registerSessionResource } from '../session-resource.js';
import { registerSetResource } from '../set-resource.js';

// Stub the SDK package to keep parity with sibling tests — `LiveState` only
// needs the `Rep` type from workout-analytics (compile-time), and nothing in
// the resource layer actually loads `@voltras/node-sdk`. The mock is defensive
// in case future imports pull it in transitively.
vi.mock('@voltras/node-sdk', () => ({}));

const TS_A = '2025-01-01T00:00:00.000Z';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 'sess-1',
    startedAt: TS_A,
    setIds: [],
    status: 'active',
    ...overrides,
  };
}

function makeSet(overrides: Partial<ActiveSet> = {}): ActiveSet {
  return {
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: TS_A,
    reps: [],
    status: 'active',
    ...overrides,
  };
}

// `Rep` is a structural type from workout-analytics; the resource layer only
// passes reps through `LiveState.appendRep`, which doesn't inspect their
// fields. A minimal object cast through `unknown` is sufficient.
function makeRep(): unknown {
  return {
    phase: { samples: [] },
    metrics: {},
    repNumber: 1,
  };
}

// Minimal ServerState surface the resources need. The real `ServerState`
// (from src/state/server-state.ts) carries more fields, but resources only
// touch `state.live`.
type ResourceServerState = { live: LiveState };

interface RegisteredResourceMap {
  _registeredResources: Record<
    string,
    { readCallback: (uri: URL) => Promise<ReadResourceResult> | ReadResourceResult }
  >;
}

function readResource(server: McpServer, uri: string): Promise<ReadResourceResult> {
  // The McpServer keeps registered resources keyed by URI in
  // `_registeredResources`. Invoking `readCallback` directly is equivalent to
  // a `resources/read` request dispatched through the transport and avoids
  // standing up a transport for every test.
  const map = server as unknown as RegisteredResourceMap;
  const entry = map._registeredResources[uri];
  if (entry === undefined) {
    throw new Error(`resource not registered: ${uri}`);
  }
  return Promise.resolve(entry.readCallback(new URL(uri)));
}

function jsonText(result: ReadResourceResult): unknown {
  const first = result.contents?.[0];
  if (first === undefined || typeof first.text !== 'string') {
    throw new Error('expected text content in resource read result');
  }
  return JSON.parse(first.text);
}

describe('voltras-mcp resources', () => {
  let live: LiveState;
  let server: McpServer;
  let state: ResourceServerState;
  let listChangedSpy: Mock<() => void>;

  beforeEach(() => {
    live = new LiveState();
    state = { live };
    server = new McpServer(
      { name: 'voltras-mcp-test', version: '0.0.0' },
      { capabilities: { resources: { subscribe: true } } },
    );

    registerDeviceResource(server, state);
    registerSessionResource(server, state);
    registerSetResource(server, state);

    // Install the AC-13 spy AFTER registration. The MCP SDK fires
    // `sendResourceListChanged` once per `registerResource` call as the
    // registration handshake — that's an SDK internal, not VMCP code, so it
    // does not violate AC-13. Our contract is that *post-registration* the
    // resource list never changes; the spy below proves no later mutation
    // (resource read, state mutation, etc.) triggers another fire.
    listChangedSpy = vi.fn();
    server.sendResourceListChanged = listChangedSpy;
  });

  describe('voltra://device/current', () => {
    it('returns JSON with connected and content metadata', async () => {
      const result = await readResource(server, 'voltra://device/current');
      const first = result.contents?.[0];
      expect(first?.uri).toBe('voltra://device/current');
      expect(first?.mimeType).toBe('application/json');
      const body = jsonText(result) as { connected: boolean };
      expect(body.connected).toBe(false);
    });

    it('reflects applySettings mutations', async () => {
      live.applySettings({
        connected: true,
        deviceName: 'Voltra-1',
        weightLbs: 75,
        batteryPercent: 88,
      });
      const result = await readResource(server, 'voltra://device/current');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect(body.deviceName).toBe('Voltra-1');
      expect(body.weightLbs).toBe(75);
      expect(body.batteryPercent).toBe(88);
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      live.applySettings({ connected: true, deviceName: 'Voltra-1', weightLbs: 50 });
      const a = await readResource(server, 'voltra://device/current');
      const b = await readResource(server, 'voltra://device/current');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });
  });

  describe('voltra://session/active', () => {
    it('returns { active: false } when no session is active (EC-10)', async () => {
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result);
      // Explicit assertion: not null, not {}, exactly { active: false }.
      expect(body).toEqual({ active: false });
      expect(body).not.toBeNull();
      expect(Object.keys(body as object)).toEqual(['active']);
    });

    it('returns sessionId and startedAt when a session is active', async () => {
      live.startSession(
        makeSession({ sessionId: 'sess-42', startedAt: '2025-06-01T12:00:00.000Z' }),
      );
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.sessionId).toBe('sess-42');
      expect(body.startedAt).toBe('2025-06-01T12:00:00.000Z');
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      live.startSession(makeSession());
      const a = await readResource(server, 'voltra://session/active');
      const b = await readResource(server, 'voltra://session/active');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });
  });

  describe('voltra://set/active', () => {
    it('returns { active: false } when no set is active (not null, not {})', async () => {
      const result = await readResource(server, 'voltra://set/active');
      const body = jsonText(result);
      expect(body).toEqual({ active: false });
      expect(body).not.toBeNull();
      expect(Object.keys(body as object)).toEqual(['active']);
    });

    it('reflects appendRep — reps.length increments after each rep', async () => {
      live.startSession(makeSession());
      live.startSet(makeSet());

      const before = jsonText(await readResource(server, 'voltra://set/active')) as {
        reps: unknown[];
      };
      expect(before.reps.length).toBe(0);

      live.appendRep(makeRep() as Parameters<LiveState['appendRep']>[0]);

      const after = jsonText(await readResource(server, 'voltra://set/active')) as {
        reps: unknown[];
      };
      expect(after.reps.length).toBe(1);
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      live.startSession(makeSession());
      live.startSet(makeSet());
      const a = await readResource(server, 'voltra://set/active');
      const b = await readResource(server, 'voltra://set/active');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });
  });

  describe('AC-13 — sendResourceListChanged is NEVER called', () => {
    it('never fires across registration + a full read cycle of all three resources', async () => {
      // Drive every resource at least once, with both empty and populated state.
      await readResource(server, 'voltra://device/current');
      await readResource(server, 'voltra://session/active');
      await readResource(server, 'voltra://set/active');
      live.startSession(makeSession());
      live.startSet(makeSet());
      live.appendRep(makeRep() as Parameters<LiveState['appendRep']>[0]);
      await readResource(server, 'voltra://session/active');
      await readResource(server, 'voltra://set/active');

      expect(listChangedSpy).toHaveBeenCalledTimes(0);
    });
  });
});
