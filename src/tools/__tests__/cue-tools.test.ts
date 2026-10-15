// Unit tests for `system.set_cues` (src/tools/cue-tools.ts, VMCP-02.85).
//
// The tool's whole value is that it moves the SAME settings object the live
// emitter reads, so the last case here drives a real CueTeePublisher through
// the tool rather than asserting on the returned JSON alone.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerCueTools } = await import('../cue-tools.js');
import type { CueToolState } from '../cue-tools.js';
import type { SetRiskReading } from '../../analytics/set-risk.js';
const { CueEmitter, CueTeePublisher } = await import('../../voice/cue-emitter.js');

import { CueSelector } from '../../voice/cue-templates.js';
import type { CueSettings } from '../../voice/cue-settings.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { SpeakDeps } from '../tts-tools.js';
import type { ToolResult } from '../helpers.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<ToolResult>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<ToolResult> }): void;
}

function setup(
  settings: CueSettings,
  slots?: CueToolState['slots'],
): {
  call: (args: unknown) => Promise<{ body: Record<string, unknown>; isError?: boolean }>;
} {
  const tool: FakeRegisteredTool = {
    update(updates) {
      tool.callback = updates.callback;
    },
  };
  const placeholders = new Map<string, FakeRegisteredTool>([['system.set_cues', tool]]);
  const state: CueToolState = { cueSettings: settings, ...(slots === undefined ? {} : { slots }) };
  registerCueTools({} as never, state, placeholders as never);
  return {
    call: async (args) => {
      const result = await tool.callback!(args);
      return {
        body: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
        isError: result.isError,
      };
    },
  };
}

describe('system.set_cues', () => {
  it('turns cues on and reports the resulting state', async () => {
    const settings: CueSettings = { enabled: false, midSetEnabled: false, midSetMode: 'off' };
    const { call } = setup(settings);

    const { body } = await call({ cues: 'on' });

    expect(settings.enabled).toBe(true);
    expect(body).toMatchObject({ cues: 'on', midSet: 'off', changed: true });
  });

  it('toggles midSet independently of the master switch', async () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: false, midSetMode: 'off' };
    const { call } = setup(settings);

    const { body } = await call({ midSet: 'on' });

    expect(settings).toEqual({ enabled: true, midSetEnabled: true, midSetMode: 'on' });
    expect(body).toMatchObject({ cues: 'on', midSet: 'on' });
  });

  it('accepts midSet risk and turns the legacy mid-set switch off (VW-614)', async () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: true, midSetMode: 'on' };
    const { call } = setup(settings);

    const { body } = await call({ midSet: 'risk' });

    expect(settings).toEqual({ enabled: true, midSetEnabled: false, midSetMode: 'risk' });
    expect(body).toMatchObject({ cues: 'on', midSet: 'risk', changed: true });
  });

  it('leaves an omitted field untouched', async () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: true, midSetMode: 'on' };
    const { call } = setup(settings);

    await call({ cues: 'off' });

    expect(settings).toEqual({ enabled: false, midSetEnabled: true, midSetMode: 'on' });
  });

  it('reports current state without changing anything when called with no fields', async () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: false, midSetMode: 'off' };
    const { call } = setup(settings);

    const { body } = await call({});

    expect(settings).toEqual({ enabled: true, midSetEnabled: false, midSetMode: 'off' });
    expect(body).toMatchObject({ cues: 'on', midSet: 'off', changed: false });
  });

  it('reports changed: false when the requested value is already set', async () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: true, midSetMode: 'on' };
    const { call } = setup(settings);

    const { body } = await call({ cues: 'on', midSet: 'on' });

    expect(body.changed).toBe(false);
  });

  it('rejects an unknown value instead of silently ignoring it', async () => {
    const { call } = setup({ enabled: false, midSetEnabled: false, midSetMode: 'off' });

    const { body, isError } = await call({ cues: 'yes' });

    expect(isError).toBe(true);
    expect(body.code).toBe('INVALID_INPUT');
  });

  it('rejects unknown fields (a typo must not read as a silent no-op)', async () => {
    const { call } = setup({ enabled: false, midSetEnabled: false, midSetMode: 'off' });

    const { isError } = await call({ midset: 'on' });

    expect(isError).toBe(true);
  });

  it('throws if the placeholder is missing', () => {
    const placeholders = new Map<string, FakeRegisteredTool>();
    expect(() =>
      registerCueTools(
        {} as never,
        { cueSettings: { enabled: false, midSetEnabled: false, midSetMode: 'off' } },
        placeholders as never,
      ),
    ).toThrow(/system\.set_cues/);
  });

  it('drives the live emitter: cues off at boot, on after the tool call', async () => {
    // End-to-end over the two structural fixes — the tee is installed despite
    // cues being off, and the emitter re-reads the settings the tool mutated.
    const settings: CueSettings = { enabled: false, midSetEnabled: false, midSetMode: 'off' };
    const { call } = setup(settings);
    const speakSpy = vi.fn(() => Promise.resolve({ content: [] } as unknown as ToolResult));
    const published: ChannelEvent[] = [];
    const inner: ChannelPublisher = {
      publish: (e) => published.push(e),
      forSlot: () => inner,
    };
    const tee = new CueTeePublisher(
      inner,
      new CueEmitter({
        speakDeps: {
          platform: 'darwin',
          spawn: (() => undefined) as unknown as SpeakDeps['spawn'],
        },
        speak: speakSpy as never,
        selector: new CueSelector({ rng: () => 0 }),
        settings,
      }),
    );
    const setStarted = (setId: string): ChannelEvent => ({
      meta: { event_type: 'set_started', set_id: setId, weight_lbs: '100' },
      content: JSON.stringify({}),
    });

    tee.publish(setStarted('s1'));
    expect(speakSpy).not.toHaveBeenCalled();

    await call({ cues: 'on' });
    tee.publish(setStarted('s2'));

    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(2);
  });
});

describe('system.set_cues live set risk (VW-615)', () => {
  const amber: SetRiskReading = {
    band: 'amber',
    points: 4,
    factors: { exercise: 1, intensity: 2, load: 1, fatigue: 0 },
    vetoes: [],
    permitsIntraSet: false,
  };

  /** Slot `primary` lifting `set-a` with `amber` pinned; slot `left` lifting `set-b` with nothing pinned. */
  function liftingSlots(): CueToolState['slots'] {
    const live = (setId: string, pinned: SetRiskReading | undefined) => ({
      set: { setId } as never,
      setRiskReadingFor: (id: string) => (id === setId ? pinned : undefined),
    });
    return new Map([
      ['primary', { live: live('set-a', amber) }],
      ['left', { live: live('set-b', undefined) }],
      ['right', { live: { set: undefined, setRiskReadingFor: () => undefined } }],
    ]);
  }

  it('reports the mode and each live set band under risk', async () => {
    // Arrange
    const settings: CueSettings = { enabled: true, midSetEnabled: false, midSetMode: 'risk' };
    const { call } = setup(settings, liftingSlots());

    // Act
    const { body } = await call({});

    // Assert
    expect(body).toMatchObject({ midSet: 'risk' });
    expect(body.liveSetRisk).toEqual([
      {
        slot: 'primary',
        setId: 'set-a',
        band: 'amber',
        points: 4,
        factors: { exercise: 1, intensity: 2, load: 1, fatigue: 0 },
        vetoes: [],
      },
      { slot: 'left', setId: 'set-b', band: null, points: null, factors: null, vetoes: [] },
    ]);
  });

  it.each(['off', 'on'] as const)('keeps the %s reply shape unchanged', async (mode) => {
    // Arrange
    const settings: CueSettings = {
      enabled: true,
      midSetEnabled: mode === 'on',
      midSetMode: mode,
    };
    const { call } = setup(settings, liftingSlots());

    // Act
    const { body } = await call({});

    // Assert
    expect(Object.keys(body).sort()).toEqual(['changed', 'cues', 'midSet', 'platformSupported']);
  });
});
