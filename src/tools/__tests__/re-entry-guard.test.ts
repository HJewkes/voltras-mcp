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
const GUARDED_TOOLS: ReadonlyArray<readonly [string, unknown]> = [
  ['isometric.measure_max', { slot: 'primary' }],
  ['isometric.measure_imbalance', { primarySlot: 'primary', secondarySlot: 'secondary' }],
  ['device.set_eccentric', { overloadLbs: 20 }],
  ['device.set_isokinetic_ecc_overload_weight', { lbs: 20 }],
  [
    'bilateral.cascade',
    { mode: 'WeightTraining', weightLbs: 50, eccentricOverloadLbs: 20, chainsLbs: 0 },
  ],
  [
    'device.configure_isokinetic',
    { targetSpeedMmPerSec: 500, eccMode: 'isokinetic', eccOverloadWeightLbs: 20 },
  ],
];

let store: SessionStore;
let client: FakeClient;
let callbacks: Map<string, Callback>;

function fakeSlot(slotId: string, slotClient: FakeClient): object {
  return {
    slotId,
    client: slotClient,
    live: { snapshotDevice: () => ({ weightLbs: 50 }) },
  };
}

function registerTools(): void {
  client = {
    isConnected: true,
    setEccentric: vi.fn(async () => undefined),
    setIsokineticEccOverloadWeight: vi.fn(async () => undefined),
  };
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

async function trainOn(id: string, day: string): Promise<void> {
  const startedAt = `${day}T12:00:00.000Z`;
  await seedTrainingDay(store, { id, startedAt, endedAt: startedAt });
}

/** A 60-day break that the lifter closed on 2026-09-30, opening a two-week window. */
async function seedMediumReturn(): Promise<void> {
  await trainOn('s-before', '2026-08-01');
  await trainOn('s-back', '2026-09-30');
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

    await expect(assertOutsideReEntryWindow(store, 'max_test')).rejects.toThrow(WINDOW_ENDS_ON);
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

async function expectAllowed(): Promise<void> {
  await expect(assertOutsideReEntryWindow(store, 'max_test')).resolves.toBeUndefined();
  expect((await call('device.set_eccentric', { overloadLbs: 20 })).isError).toBeUndefined();
  const isokinetic = await call('device.set_isokinetic_ecc_overload_weight', { lbs: 20 });
  expect(isokinetic.isError).toBeUndefined();
  expect(client.setEccentric).toHaveBeenCalledWith(20);
  expect(client.setIsokineticEccOverloadWeight).toHaveBeenCalledWith(20);
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
