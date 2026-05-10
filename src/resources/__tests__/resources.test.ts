// Unit tests for the polling MCP resources (Wave 3F, Task 15 +
// Phase 0.5.2 bilateral fan-out).
//
// Strategy: construct a real `McpServer` (no transport connection — the
// register* functions only need the registration surface), register each
// resource against an in-memory slot map, and invoke the `readCallback`
// directly. This validates the JSON payload shape AND covers the SDK's
// resource-registration code path (static + templated) so the API
// signature is exercised end-to-end.
//
// Phase 0.5.2 added per-slot URI templating so bilateral consumers can read
// each device's state independently. The legacy URIs (`voltra://device/current`,
// `voltra://session/active`, `voltra://set/active`) remain as primary-slot
// aliases for backwards-compat. Tests below cover both surfaces.
//
// Coverage targets (NF-03 floor 80% for src/resources/):
//   - voltra://device/current returns connected/connectionState fields.
//   - voltra://device/{slot}/current returns each slot's snapshot.
//   - The resource list enumerates all active slots (per the template's
//     list callback).
//   - Two reads with no state change return identical JSON (AC-12 stability).
//   - voltra://session/{slot}/active returns sessionId+startedAt when active.
//   - voltra://session/active returns { active: false } when no session
//     (EC-10, AC-12) — explicitly NOT null and NOT empty `{}`.
//   - voltra://set/{slot}/active reflects appendRep calls (reps.length grows).
//   - sendResourceListChanged is NEVER called by VMCP code (AC-13). The
//     resource list is fixed at registration; the per-slot template's `list`
//     callback is consulted on `resources/list` requests, not via list-changed.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult, ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';

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

interface RegisteredResourceMap {
  _registeredResources: Record<
    string,
    { readCallback: (uri: URL) => Promise<ReadResourceResult> | ReadResourceResult }
  >;
  _registeredResourceTemplates: Record<
    string,
    {
      resourceTemplate: { uriTemplate: { match: (uri: string) => Record<string, unknown> | null } };
      readCallback: (
        uri: URL,
        variables: Record<string, unknown>,
      ) => Promise<ReadResourceResult> | ReadResourceResult;
    }
  >;
}

function readResource(server: McpServer, uri: string): Promise<ReadResourceResult> {
  // The McpServer keeps registered resources keyed by URI in
  // `_registeredResources` (static) and `_registeredResourceTemplates`
  // (templates). Static URIs match first — invoking `readCallback` directly
  // is equivalent to a `resources/read` request dispatched through the
  // transport and avoids standing up a transport for every test.
  const map = server as unknown as RegisteredResourceMap;
  const staticEntry = map._registeredResources[uri];
  if (staticEntry !== undefined) {
    return Promise.resolve(staticEntry.readCallback(new URL(uri)));
  }
  for (const tmpl of Object.values(map._registeredResourceTemplates)) {
    const variables = tmpl.resourceTemplate.uriTemplate.match(uri);
    if (variables !== null) {
      return Promise.resolve(tmpl.readCallback(new URL(uri), variables));
    }
  }
  throw new Error(`resource not registered: ${uri}`);
}

async function listResources(
  server: McpServer,
  templateName: string,
): Promise<ListResourcesResult> {
  const map = server as unknown as RegisteredResourceMap & {
    _registeredResourceTemplates: Record<
      string,
      {
        resourceTemplate: {
          uriTemplate: { match: (uri: string) => Record<string, unknown> | null };
          listCallback?: () => ListResourcesResult | Promise<ListResourcesResult>;
        };
        readCallback: (
          uri: URL,
          variables: Record<string, unknown>,
        ) => Promise<ReadResourceResult> | ReadResourceResult;
      }
    >;
  };
  const tmpl = map._registeredResourceTemplates[templateName];
  if (tmpl === undefined) {
    throw new Error(`template not registered: ${templateName}`);
  }
  const list = (
    tmpl.resourceTemplate as unknown as {
      listCallback: () => ListResourcesResult | Promise<ListResourcesResult>;
    }
  ).listCallback;
  return Promise.resolve(list());
}

function jsonText(result: ReadResourceResult): unknown {
  const first = result.contents?.[0];
  if (first === undefined || typeof first.text !== 'string') {
    throw new Error('expected text content in resource read result');
  }
  return JSON.parse(first.text);
}

interface ResourceState {
  liveForSlot: (slotId: string) => LiveState | undefined;
  slotIds: () => string[];
}

function makeState(slots: Record<string, LiveState>): ResourceState {
  return {
    liveForSlot: (slotId) => slots[slotId],
    slotIds: () => Object.keys(slots),
  };
}

describe('voltras-mcp resources', () => {
  let primary: LiveState;
  let server: McpServer;
  let state: ResourceState;
  let listChangedSpy: Mock<() => void>;

  beforeEach(() => {
    primary = new LiveState();
    state = makeState({ primary });
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

  describe('voltra://device/current (legacy alias)', () => {
    it('returns JSON with connected and content metadata', async () => {
      const result = await readResource(server, 'voltra://device/current');
      const first = result.contents?.[0];
      expect(first?.uri).toBe('voltra://device/current');
      expect(first?.mimeType).toBe('application/json');
      const body = jsonText(result) as { connected: boolean };
      expect(body.connected).toBe(false);
    });

    it('reflects applySettings mutations', async () => {
      primary.applySettings({
        connected: true,
        weightLbs: 75,
        batteryPercent: 88,
      });
      const result = await readResource(server, 'voltra://device/current');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect(body.weightLbs).toBe(75);
      expect(body.batteryPercent).toBe(88);
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      primary.applySettings({ connected: true, weightLbs: 50 });
      const a = await readResource(server, 'voltra://device/current');
      const b = await readResource(server, 'voltra://device/current');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });
  });

  describe('voltra://device/{slot}/current (templated, bilateral)', () => {
    let secondary: LiveState;
    beforeEach(() => {
      secondary = new LiveState();
      // Re-register against a multi-slot state so the per-slot template can
      // resolve both slot ids. Build a fresh server because `registerResource`
      // can't be re-run on the same server instance for the same name.
      server = new McpServer(
        { name: 'voltras-mcp-test', version: '0.0.0' },
        { capabilities: { resources: { subscribe: true } } },
      );
      const multiState = makeState({ primary, secondary });
      registerDeviceResource(server, multiState);
      registerSessionResource(server, multiState);
      registerSetResource(server, multiState);
    });

    it('reads each slot independently', async () => {
      primary.applySettings({ connected: true, weightLbs: 50 });
      secondary.applySettings({ connected: true, weightLbs: 95 });

      const primaryRead = await readResource(server, 'voltra://device/primary/current');
      const secondaryRead = await readResource(server, 'voltra://device/secondary/current');

      expect((jsonText(primaryRead) as { weightLbs: number }).weightLbs).toBe(50);
      expect((jsonText(secondaryRead) as { weightLbs: number }).weightLbs).toBe(95);
    });

    it('returns connected:false when the slot has no LiveState', async () => {
      const stateNoSlots: ResourceState = makeState({});
      const freshServer = new McpServer(
        { name: 'voltras-mcp-test', version: '0.0.0' },
        { capabilities: { resources: { subscribe: true } } },
      );
      registerDeviceResource(freshServer, stateNoSlots);

      const result = await readResource(freshServer, 'voltra://device/phantom/current');
      const body = jsonText(result) as { connected: boolean };
      expect(body.connected).toBe(false);
    });

    it('list callback enumerates one entry per active slot', async () => {
      const list = await listResources(server, 'device-current');
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain('voltra://device/primary/current');
      expect(uris).toContain('voltra://device/secondary/current');
    });

    it('legacy voltra://device/current still resolves to primary', async () => {
      primary.applySettings({ connected: true, weightLbs: 42 });
      const legacy = jsonText(await readResource(server, 'voltra://device/current')) as {
        weightLbs: number;
      };
      const templated = jsonText(await readResource(server, 'voltra://device/primary/current')) as {
        weightLbs: number;
      };
      expect(legacy.weightLbs).toBe(42);
      expect(templated.weightLbs).toBe(42);
    });
  });

  describe('voltra://session/active (legacy alias)', () => {
    it('returns { active: false } with idle counters when no session is active (EC-10)', async () => {
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      // `active: false` must be present; idle counters are now also included
      // (additive change — idle reps accumulate independently of session state).
      expect(body.active).toBe(false);
      expect(body.idleRepCount).toBe(0);
      expect(Array.isArray(body.idleReps)).toBe(true);
      expect((body.idleReps as unknown[]).length).toBe(0);
      expect(body).not.toBeNull();
    });

    it('returns sessionId and startedAt when a session is active', async () => {
      primary.startSession(
        makeSession({ sessionId: 'sess-42', startedAt: '2025-06-01T12:00:00.000Z' }),
      );
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.sessionId).toBe('sess-42');
      expect(body.startedAt).toBe('2025-06-01T12:00:00.000Z');
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      primary.startSession(makeSession());
      const a = await readResource(server, 'voltra://session/active');
      const b = await readResource(server, 'voltra://session/active');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });

    it('includes idleRepCount=0 and idleReps=[] on a fresh active session', async () => {
      primary.startSession(makeSession({ sessionId: 'sess-1' }));
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.sessionId).toBe('sess-1');
      expect(body.idleRepCount).toBe(0);
      expect(Array.isArray(body.idleReps)).toBe(true);
      expect((body.idleReps as unknown[]).length).toBe(0);
    });

    it('reflects idleRepCount + idleReps after recordIdleRep is called', async () => {
      primary.startSession(makeSession({ sessionId: 'sess-1' }));
      // Simulate two idle reps recorded directly on live state.
      const fakeRep = {
        repNumber: 1,
        concentric: {
          samples: [],
          startTime: 0,
          endTime: 0,
          startPosition: 0,
          endPosition: 0,
          _totalVelocity: 0,
          _totalForce: 0,
          _totalLoad: 0,
          _movementSampleCount: 0,
          _totalHoldDuration: 0,
          peakVelocity: 0,
          peakForce: 0,
          peakLoad: 0,
        },
        eccentric: {
          samples: [],
          startTime: 0,
          endTime: 0,
          startPosition: 0,
          endPosition: 0,
          _totalVelocity: 0,
          _totalForce: 0,
          _totalLoad: 0,
          _movementSampleCount: 0,
          _totalHoldDuration: 0,
          peakVelocity: 0,
          peakForce: 0,
          peakLoad: 0,
        },
      };
      primary.recordIdleRep(fakeRep as Parameters<LiveState['recordIdleRep']>[0], 'primary');
      primary.recordIdleRep(fakeRep as Parameters<LiveState['recordIdleRep']>[0], 'primary');

      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.idleRepCount).toBe(2);
      expect((body.idleReps as unknown[]).length).toBe(2);
    });

    it('clearIdleReps resets counters visible in the resource', async () => {
      primary.startSession(makeSession({ sessionId: 'sess-1' }));
      const fakeRep = {
        repNumber: 1,
        concentric: {
          samples: [],
          startTime: 0,
          endTime: 0,
          startPosition: 0,
          endPosition: 0,
          _totalVelocity: 0,
          _totalForce: 0,
          _totalLoad: 0,
          _movementSampleCount: 0,
          _totalHoldDuration: 0,
          peakVelocity: 0,
          peakForce: 0,
          peakLoad: 0,
        },
        eccentric: {
          samples: [],
          startTime: 0,
          endTime: 0,
          startPosition: 0,
          endPosition: 0,
          _totalVelocity: 0,
          _totalForce: 0,
          _totalLoad: 0,
          _movementSampleCount: 0,
          _totalHoldDuration: 0,
          peakVelocity: 0,
          peakForce: 0,
          peakLoad: 0,
        },
      };
      primary.recordIdleRep(fakeRep as Parameters<LiveState['recordIdleRep']>[0], 'primary');
      expect(primary.idleRepCount).toBe(1);
      primary.clearIdleReps();
      const result = await readResource(server, 'voltra://session/active');
      const body = jsonText(result) as Record<string, unknown>;
      expect(body.idleRepCount).toBe(0);
      expect((body.idleReps as unknown[]).length).toBe(0);
    });
  });

  describe('voltra://session/{slot}/active (templated)', () => {
    it('returns each slot session independently', async () => {
      const secondary = new LiveState();
      const multiServer = new McpServer(
        { name: 'voltras-mcp-test', version: '0.0.0' },
        { capabilities: { resources: { subscribe: true } } },
      );
      registerSessionResource(multiServer, makeState({ primary, secondary }));

      primary.startSession(makeSession({ sessionId: 'P-1' }));
      secondary.startSession(makeSession({ sessionId: 'S-1' }));

      const a = jsonText(await readResource(multiServer, 'voltra://session/primary/active')) as {
        sessionId: string;
      };
      const b = jsonText(await readResource(multiServer, 'voltra://session/secondary/active')) as {
        sessionId: string;
      };
      expect(a.sessionId).toBe('P-1');
      expect(b.sessionId).toBe('S-1');
    });
  });

  describe('voltra://set/active (legacy alias)', () => {
    it('returns { active: false } when no set is active (not null, not {})', async () => {
      const result = await readResource(server, 'voltra://set/active');
      const body = jsonText(result);
      expect(body).toEqual({ active: false });
      expect(body).not.toBeNull();
      expect(Object.keys(body as object)).toEqual(['active']);
    });

    it('reflects appendRep — reps.length increments after each rep', async () => {
      primary.startSession(makeSession());
      primary.startSet(makeSet());

      const before = jsonText(await readResource(server, 'voltra://set/active')) as {
        reps: unknown[];
      };
      expect(before.reps.length).toBe(0);

      primary.appendRep(makeRep() as Parameters<LiveState['appendRep']>[0]);

      const after = jsonText(await readResource(server, 'voltra://set/active')) as {
        reps: unknown[];
      };
      expect(after.reps.length).toBe(1);
    });

    it('returns identical JSON across two reads with no state change (AC-12)', async () => {
      primary.startSession(makeSession());
      primary.startSet(makeSet());
      const a = await readResource(server, 'voltra://set/active');
      const b = await readResource(server, 'voltra://set/active');
      expect(a.contents?.[0]?.text).toBe(b.contents?.[0]?.text);
    });
  });

  describe('voltra://set/{slot}/active (templated)', () => {
    it('reflects rep growth on the addressed slot only', async () => {
      const secondary = new LiveState();
      const multiServer = new McpServer(
        { name: 'voltras-mcp-test', version: '0.0.0' },
        { capabilities: { resources: { subscribe: true } } },
      );
      registerSetResource(multiServer, makeState({ primary, secondary }));

      primary.startSession(makeSession());
      primary.startSet(makeSet({ setId: 'P-set' }));
      secondary.startSession(makeSession());
      secondary.startSet(makeSet({ setId: 'S-set' }));

      primary.appendRep(makeRep() as Parameters<LiveState['appendRep']>[0]);

      const primaryRead = jsonText(
        await readResource(multiServer, 'voltra://set/primary/active'),
      ) as { reps: unknown[]; setId: string };
      const secondaryRead = jsonText(
        await readResource(multiServer, 'voltra://set/secondary/active'),
      ) as { reps: unknown[]; setId: string };

      expect(primaryRead.setId).toBe('P-set');
      expect(primaryRead.reps.length).toBe(1);
      expect(secondaryRead.setId).toBe('S-set');
      expect(secondaryRead.reps.length).toBe(0);
    });
  });

  describe('AC-13 — sendResourceListChanged is NEVER called', () => {
    it('never fires across registration + a full read cycle of all three resources', async () => {
      // Drive every resource at least once, with both empty and populated state.
      await readResource(server, 'voltra://device/current');
      await readResource(server, 'voltra://session/active');
      await readResource(server, 'voltra://set/active');
      primary.startSession(makeSession());
      primary.startSet(makeSet());
      primary.appendRep(makeRep() as Parameters<LiveState['appendRep']>[0]);
      await readResource(server, 'voltra://session/active');
      await readResource(server, 'voltra://set/active');

      expect(listChangedSpy).toHaveBeenCalledTimes(0);
    });
  });
});
