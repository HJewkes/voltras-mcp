// The return-window guard refuses max tests and eccentric overload in the first weeks back after
// a medium break, and names the window's last day rather than a day count (VW-978).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    VoltraSDKError: FakeVoltraSDKError,
    TrainingMode: { WeightTraining: 1, Isokinetic: 7, 1: 'WeightTraining', 7: 'Isokinetic' },
    TrainingModeNames: { 1: 'Weight Training', 7: 'Isokinetic' },
  };
});

vi.mock('../../state/event-bridge.js', () => ({ wireBridgeForSlot: vi.fn(() => vi.fn()) }));

const { registerDeviceTools } = await import('../device-tools.js');
const { registerIsometricTools } = await import('../isometric-tools.js');
const { assertOutsideReEntryWindow } = await import('../re-entry-guard.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface FakeClient {
  isConnected: boolean;
  setEccentric: ReturnType<typeof vi.fn>;
  setIsokineticEccOverloadWeight: ReturnType<typeof vi.fn>;
}

const WINDOW_ENDS_ON = '2026-10-13';
const GUEST = 'Jordan';
const CASCADE_ARGS = {
  mode: 'WeightTraining',
  weightLbs: 50,
  eccentricOverloadLbs: 20,
  chainsLbs: 0,
};
const GUARDED_TOOLS: ReadonlyArray<readonly [string, unknown]> = [
  ['isometric.measure_max', { slot: 'primary' }],
  ['isometric.measure_imbalance', { primarySlot: 'primary', secondarySlot: 'secondary' }],
  ['device.set_eccentric', { overloadLbs: 20 }],
  ['device.set_isokinetic_ecc_overload_weight', { lbs: 20 }],
  ['bilateral.cascade', CASCADE_ARGS],
  [
    'device.configure_isokinetic',
    { targetSpeedMmPerSec: 500, eccMode: 'isokinetic', eccOverloadWeightLbs: 20 },
  ],
];

let store: SessionStore;
let client: FakeClient;
let callbacks: Map<string, Callback>;
let lives: Map<string, FakeLive>;

interface FakeLive {
  session?: { sessionId: string; lifter?: string };
  set?: { lifter?: string };
  snapshotDevice: () => { weightLbs: number };
}

function fakeSlot(slotId: string, slotClient: FakeClient): object {
  const live: FakeLive = { snapshotDevice: () => ({ weightLbs: 50 }) };
  lives.set(slotId, live);
  return { slotId, client: slotClient, live };
}

/** Opens a session on one slot for `lifter`; `undefined` is the owner. */
function openSession(slotId: string, lifter: string | undefined): void {
  lives.get(slotId)!.session = { sessionId: `live-${slotId}`, ...(lifter && { lifter }) };
}

function openSessions(lifter: string | undefined): void {
  openSession('primary', lifter);
  openSession('secondary', lifter);
}

function registerTools(): void {
  client = {
    isConnected: true,
    setEccentric: vi.fn(async () => undefined),
    setIsokineticEccOverloadWeight: vi.fn(async () => undefined),
  };
  lives = new Map();
  const state = {
    config: { adapter: 'mock', mountRatingLbs: undefined },
    store,
    slots: new Map([
      ['primary', fakeSlot('primary', client)],
      ['secondary', fakeSlot('secondary', { ...client })],
    ]),
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerDeviceTools({} as never, state, placeholders as never);
  registerIsometricTools({} as never, state, placeholders as never);
}

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await callbacks.get(name)!(args);
  return { isError: result.isError, ...(JSON.parse(result.content[0].text) as object) };
}

async function trainOn(id: string, day: string, lifter?: string): Promise<void> {
  const startedAt = `${day}T12:00:00.000Z`;
  await seedTrainingDay(store, { id, startedAt, endedAt: startedAt, ...(lifter && { lifter }) });
}

/** A 60-day break that the lifter closed on 2026-09-30, opening a two-week window. */
async function seedMediumReturn(lifter?: string): Promise<void> {
  const who = lifter ?? 'owner';
  await trainOn(`s-before-${who}`, '2026-08-01', lifter);
  await trainOn(`s-back-${who}`, '2026-09-30', lifter);
}

/** Two recent training days with no break between them, so no window is open. */
async function seedSteadyTraining(lifter?: string): Promise<void> {
  const who = lifter ?? 'owner';
  await trainOn(`s-steady-a-${who}`, '2026-09-27', lifter);
  await trainOn(`s-steady-b-${who}`, '2026-09-30', lifter);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  store = openTestStore();
  registerTools();
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('in week 1 after a 60-day gap', () => {
  it.each(GUARDED_TOOLS)('%s refuses and names the window end date', async (name, args) => {
    await seedMediumReturn();

    const result = await call(name, args);

    expect(result.isError).toBe(true);
    expect(result.code).toBe('RE_ENTRY_WINDOW');
    expect(result.message).toContain(WINDOW_ENDS_ON);
    expect(result.message).not.toMatch(/\bdays?\b/i);
    expect(client.setEccentric).not.toHaveBeenCalled();
    expect(client.setIsokineticEccOverloadWeight).not.toHaveBeenCalled();
  });

  it('still allows an assisted eccentric, which adds no load', async () => {
    await seedMediumReturn();

    const result = await call('device.set_eccentric', { overloadLbs: -20 });

    expect(result.isError).toBeUndefined();
    expect(client.setEccentric).toHaveBeenCalledWith(-20);
  });

  it('refuses on the window end date itself', async () => {
    await seedMediumReturn();
    vi.setSystemTime(new Date(`${WINDOW_ENDS_ON}T12:00:00.000Z`));

    await expect(assertOutsideReEntryWindow(store, 'max_test', undefined)).rejects.toThrow(
      WINDOW_ENDS_ON,
    );
  });
});

describe('outside a guarded window', () => {
  it('allows max tests and overload after a 10-day gap', async () => {
    await trainOn('s-before', '2026-09-20');
    await trainOn('s-back', '2026-09-30');

    await expectAllowed();
  });

  it('allows max tests and overload the day after the window ends', async () => {
    await seedMediumReturn();
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));

    await expectAllowed();
  });
});

describe("when the owner's window is open and the guest's is not", () => {
  beforeEach(async () => {
    await seedMediumReturn();
    await seedSteadyTraining(GUEST);
    openSessions(GUEST);
  });

  it.each(GUARDED_TOOLS)('%s is not held for the guest', async (name, args) => {
    const result = await call(name, args);

    expect(result.code).not.toBe('RE_ENTRY_WINDOW');
  });

  it('writes the guest eccentric overload to the device', async () => {
    await expectOverloadWritten();
  });

  it('holds an overload while the open set is still the owner', async () => {
    lives.get('primary')!.set = {};

    const result = await call('device.set_eccentric', { overloadLbs: 20 });

    expect(result.code).toBe('RE_ENTRY_WINDOW');
    expect(client.setEccentric).not.toHaveBeenCalled();
  });

  it('holds a cascade when one of its slots is the owner', async () => {
    openSession('secondary', undefined);

    const result = await call('bilateral.cascade', CASCADE_ARGS);

    expect(result.code).toBe('RE_ENTRY_WINDOW');
    expect(client.setEccentric).not.toHaveBeenCalled();
  });
});

describe("when the guest's window is open and the owner's is not", () => {
  beforeEach(async () => {
    await seedSteadyTraining();
    await seedMediumReturn(GUEST);
  });

  it.each(GUARDED_TOOLS)('%s refuses the guest', async (name, args) => {
    openSessions(GUEST);

    const result = await call(name, args);

    expect(result.code).toBe('RE_ENTRY_WINDOW');
    expect(result.message).toContain(WINDOW_ENDS_ON);
    expect(client.setEccentric).not.toHaveBeenCalled();
    expect(client.setIsokineticEccOverloadWeight).not.toHaveBeenCalled();
  });

  it("holds an overload during a guest set inside the owner's session", async () => {
    openSessions(undefined);
    lives.get('primary')!.set = { lifter: GUEST };

    const result = await call('device.set_eccentric', { overloadLbs: 20 });

    expect(result.code).toBe('RE_ENTRY_WINDOW');
    expect(client.setEccentric).not.toHaveBeenCalled();
  });

  it('allows the owner', async () => {
    openSessions(undefined);

    await expectOverloadWritten();
  });
});

async function expectOverloadWritten(): Promise<void> {
  expect((await call('device.set_eccentric', { overloadLbs: 20 })).isError).toBeUndefined();
  const isokinetic = await call('device.set_isokinetic_ecc_overload_weight', { lbs: 20 });
  expect(isokinetic.isError).toBeUndefined();
  expect(client.setEccentric).toHaveBeenCalledWith(20);
  expect(client.setIsokineticEccOverloadWeight).toHaveBeenCalledWith(20);
}

async function expectAllowed(): Promise<void> {
  await expect(assertOutsideReEntryWindow(store, 'max_test', undefined)).resolves.toBeUndefined();
  await expectOverloadWritten();
}

// Every guarded tool calls the guard in its own handler, so a new route to an eccentric overload
// write would slip past it. Pin the writers: a new call site fails here until it is guarded and
// listed, alongside a refusal case above.
describe('the eccentric overload writers', () => {
  it('are only the guarded handlers', () => {
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url));
    const writers = sourceFiles(srcRoot).flatMap((file) => {
      const count = codeLines(readFileSync(file, 'utf8')).match(OVERLOAD_WRITE)?.length ?? 0;
      return count === 0 ? [] : [`${relative(srcRoot, file)} x${count}`];
    });

    expect(writers.sort()).toEqual([
      // bilateral.cascade's eccentric step
      'state/bilateral-cascade.ts x1',
      // device.set_eccentric, set_isokinetic_ecc_overload_weight, configure_isokinetic
      'tools/device-tools.ts x3',
    ]);
  });
});

const OVERLOAD_WRITE = /\.(?:setEccentric|setIsokineticEccOverloadWeight)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The source with its comment lines dropped, so a comment naming a setter is not a writer. */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join('\n');
}
