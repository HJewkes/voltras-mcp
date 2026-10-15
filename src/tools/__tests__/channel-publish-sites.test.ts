// The authoritative inventory of channel `.publish(` sites under `src/` (VW-212, VW-686).
//
// Every non-test `.ts` or `.tsx` file under `src/` is walked. Each `.publish(` occurrence must be named
// in SITES below with the reason its event does, or deliberately does not, carry `meta.slot`:
//
//  - forSlot: the receiver is `forSlot(...)`, or a local bound to it (pinned by `bindings`).
//  - scoped-param: the receiver is a `channels` parameter; every caller of the helper is
//    pinned and passes a slot-scoped publisher, so a new unscoped caller fails the count.
//  - embeds-slot: the receiver is unscoped and the payload builder puts `slot` in itself.
//  - slot-free: no slot by design. Only the events in SLOT_FREE_EVENTS may sit here, and that
//    set must equal docs/push-events.md's slot-exception list.
//  - wrapper: a publisher decorator forwarding to its inner publisher.
//  - not-a-channel: a comment or a method that is not a ChannelPublisher, listed so the
//    per-file count stays exact.
//
// A file with an unlisted `.publish(` fails and names the file; so does a pinned site whose
// receiver changed, which is how an unscoped publish of a slot-aware event gets caught.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..', '..');
const PUSH_EVENTS_DOC = join(SRC_DIR, '..', 'docs', 'push-events.md');

type Category =
  | 'forSlot'
  | 'scoped-param'
  | 'embeds-slot'
  | 'slot-free'
  | 'wrapper'
  | 'not-a-channel';

interface Pin {
  file: string;
  pattern: RegExp;
  count: number;
}

interface HelperPin {
  /** The call token, e.g. `evaluateRepTriggers`; every `name(` outside its definition is a caller. */
  name: string;
  callers: Pin[];
}

interface Site {
  event: string;
  category: Category;
  /** Matches the publish expression itself, receiver included. */
  pattern: RegExp;
  count: number;
  helpers?: HelperPin[];
}

const SLOT_FREE_EVENTS = [
  'timer_complete',
  'voice_input_failed',
  'voice_input',
  'voltras_available',
  'debug.push_test_channel',
  'isometric_result',
  'coach_line',
];

const BARE_CHANNELS = '(?<![\\w.])channels';

function bare(rest: string): RegExp {
  return new RegExp(BARE_CHANNELS + rest, 'g');
}

/** Locals a forSlot site publishes through; each must be bound to a `forSlot(...)` exactly so. */
const BINDINGS: Pin[] = [
  {
    file: 'state/arm-defaults.ts',
    pattern: /const channels = state\.channels\.forSlot\(event\.slotId\);/g,
    count: 1,
  },
  {
    file: 'state/event-bridge.ts',
    pattern: /const slotChannels = channels\.forSlot\(slotId\);/g,
    count: 1,
  },
  {
    file: 'tools/isometric-tools.ts',
    pattern: /const channels = state\.channels\.forSlot\(slotId\);/g,
    count: 1,
  },
  {
    file: 'tools/set-tools.ts',
    pattern: /const slotChannels = state\.channels\.forSlot\(slotId\);/g,
    count: 1,
  },
];

const SITES: Record<string, Site[]> = {
  'state/arm-defaults.ts': [
    {
      event: 'set_updated (auto-armed defaults)',
      category: 'forSlot',
      pattern: bare('\\.publish\\(buildSetUpdatedPayload\\('),
      count: 1,
    },
  ],
  'state/auto-arm.ts': [
    {
      event: 'set_started (auto-armed)',
      category: 'forSlot',
      pattern: /state\.channels\.forSlot\(slotId\)\.publish\(/g,
      count: 1,
    },
  ],
  'state/channel-publisher.ts': [
    {
      event: 'any (slotScopedPublisher)',
      category: 'wrapper',
      pattern: /inner\.publish\(\{/g,
      count: 1,
    },
  ],
  'state/effort-cue.ts': [
    {
      event: 'effort cue',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(cuePayload\\('),
      count: 1,
      helpers: [
        {
          name: 'evaluateEffortCue',
          callers: [
            {
              file: 'state/event-bridge.ts',
              pattern: /evaluateEffortCue\(live, slotChannels,/g,
              count: 1,
            },
          ],
        },
      ],
    },
  ],
  'state/event-bridge.ts': eventBridgeSites(),
  'state/isometric-live-signal-tee.ts': [
    {
      event: 'any (isometric tee)',
      category: 'wrapper',
      pattern: /this\.inner\.publish\(event\)/g,
      count: 1,
    },
  ],
  'state/lease-fence.ts': [
    {
      event: 'lease_lost',
      category: 'forSlot',
      pattern: /deps\.channels\.forSlot\(slot\)\.publish\(/g,
      count: 1,
    },
  ],
  'state/rest-timer.ts': [
    {
      event: "RestTimer's private publish method",
      category: 'not-a-channel',
      pattern: /this\.publish\(entry, \/\*final\*\/ (?:true|false)\)/g,
      count: 3,
    },
    {
      event: 'rest_status',
      category: 'scoped-param',
      pattern: /entry\.channels\.publish\(payload\)/g,
      count: 1,
      helpers: [
        {
          name: 'restTimers.start',
          callers: [
            {
              file: 'tools/set-tools.ts',
              pattern: /restTimers\.start\(slotId, stored\.id, slotChannels\)/g,
              count: 1,
            },
          ],
        },
      ],
    },
  ],
  'state/server-state.ts': [
    {
      event: 'doc comment',
      category: 'not-a-channel',
      pattern: /\* `state\.channels\.publish\(\.\.\.\)`/g,
      count: 1,
    },
  ],
  'state/velocity-loss-gate.ts': [
    {
      event: 'velocity_loss_watch_suppressed',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(buildVelocityLossWatchSuppressedPayload\\('),
      count: 1,
      helpers: [
        {
          name: 'publishVelocityLossSuppression',
          callers: [
            {
              file: 'state/arm-defaults.ts',
              pattern: /publishVelocityLossSuppression\(channels, applied, device\)/g,
              count: 1,
            },
            {
              file: 'state/event-bridge.ts',
              pattern: /publishVelocityLossSuppression\(\s*state\.channels\.forSlot\(slotId\),/g,
              count: 1,
            },
            {
              file: 'tools/set-tools.ts',
              pattern: /publishVelocityLossSuppression\(state\.channels\.forSlot\(slotId\),/g,
              count: 2,
            },
          ],
        },
      ],
    },
  ],
  'tools/debug-tools.ts': [
    {
      event: 'debug.push_test_channel',
      category: 'slot-free',
      pattern:
        /state\.channels\.publish\(\{ content: input\.content, meta: \{ \.\.\.input\.meta, nonce \} \}\)/g,
      count: 1,
    },
  ],
  'tools/device-tools.ts': [
    {
      event: 'voltras_available',
      category: 'slot-free',
      pattern: /state\.channels\.publish\(buildVoltrasAvailablePayload\(/g,
      count: 1,
    },
  ],
  'tools/isometric-result-emit.ts': [
    {
      event: 'isometric_result',
      category: 'slot-free',
      pattern:
        /state\.channels\.publish\(\s*buildIsometricResultPayload\(\{\s*tool: 'isometric\.measure_imbalance'/g,
      count: 1,
    },
    {
      event: 'isometric_result',
      category: 'slot-free',
      pattern:
        /state\.channels\.publish\(\s*buildIsometricResultPayload\(\{\s*tool: 'isometric\.measure_max'/g,
      count: 1,
    },
  ],
  'tools/isometric-tools.ts': [
    {
      event: 'isometric_phase',
      category: 'forSlot',
      pattern: bare('\\.publish\\(\\s*buildIsometricPhasePayload\\('),
      count: 1,
    },
  ],
  'tools/session-tools.ts': [
    {
      event: 'session event',
      category: 'forSlot',
      pattern: /state\.channels\.forSlot\(input\.slot \?\? PRIMARY_SLOT\)\.publish\(/g,
      count: 1,
    },
  ],
  'tools/set-tools.ts': setToolsSites(),
  'tools/timer-tools.ts': [
    {
      event: 'timer_complete',
      category: 'slot-free',
      pattern: /state\.channels\.publish\(\{[^;]*?event_type: 'timer_complete'/g,
      count: 1,
    },
  ],
  'tools/voice-tools.ts': voiceToolsSites(),
  'tools/voice-weight.ts': [
    {
      event: 'voice_command_applied',
      category: 'embeds-slot',
      pattern: bare('\\.publish\\(\\s*buildVoiceCommandAppliedPayload\\('),
      count: 1,
    },
    {
      event: 'voice_command_rejected',
      category: 'embeds-slot',
      pattern: bare('\\.publish\\(\\s*buildVoiceCommandRejectedPayload\\('),
      count: 1,
    },
    {
      event: 'voice_input',
      category: 'slot-free',
      pattern: bare('\\.publish\\(\\s*buildVoiceInputPayload\\('),
      count: 1,
    },
  ],
  'voice/cue-delivery/delivery-emitter.ts': [
    {
      event: 'any (DeliveryTee)',
      category: 'wrapper',
      pattern: /this\.inner\.publish\(event\)/g,
      count: 1,
    },
  ],
  'voice/cue-emitter.ts': [
    {
      event: 'any (CueTeePublisher)',
      category: 'wrapper',
      pattern: /this\.inner\.publish\(event\)/g,
      count: 1,
    },
  ],
};

function eventBridgeSites(): Site[] {
  const file = 'state/event-bridge.ts';
  return [
    {
      event: 'idle_rep_reclaimed',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(\\s*buildIdleRepReclaimedPayload\\('),
      count: 1,
      helpers: [
        {
          name: 'reconcileIdleReclaim',
          callers: [
            { file, pattern: /reconcileIdleReclaim\(\{[^}]*channels: slotChannels,/g, count: 1 },
          ],
        },
      ],
    },
    {
      event: 'coach_line',
      category: 'slot-free',
      pattern: /target\.channels\.publish\(buildCoachLinePayload\(/g,
      count: 1,
    },
    {
      event: 'idle rep, rep_finalized, set close, connection and settings events',
      category: 'forSlot',
      pattern: /slotChannels\.publish\(/g,
      count: 6,
    },
    {
      event: 'set_target_reached, velocity_loss_exceeded',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(payload\\)'),
      count: 2,
      helpers: [
        {
          name: 'evaluateRepTriggers',
          callers: [{ file, pattern: /evaluateRepTriggers\(live, slotChannels,/g, count: 1 }],
        },
      ],
    },
    {
      event: 'settings_update (state dump and settings echo)',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(buildSettingsUpdatePayload\\(field, current, all\\)\\)'),
      count: 2,
      helpers: [
        {
          name: 'publishIfTransition',
          callers: [{ file, pattern: /publishIfTransition\([^;]*?\bchannels,?\s*\);/g, count: 3 }],
        },
        {
          name: 'synthStateDumpTransitions',
          callers: [
            { file, pattern: /synthStateDumpTransitions\([^;]*?\bslotChannels,?\s*\);/g, count: 1 },
          ],
        },
        {
          name: 'publishSettingsEchoUpdate',
          callers: [
            { file, pattern: /publishSettingsEchoUpdate\([^;]*?\bslotChannels\);/g, count: 3 },
          ],
        },
      ],
    },
    {
      event: 'setting_coerced',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(buildSettingCoercedPayload\\('),
      count: 1,
      helpers: [
        {
          name: 'observeCoercion',
          callers: [
            { file, pattern: /observeCoercion\([^;]*?\bchannels,\s*slotId,?\s*\);/g, count: 5 },
          ],
        },
        {
          name: 'observeSettingsUpdateCoercions',
          callers: [
            {
              file,
              pattern: /observeSettingsUpdateCoercions\([^;]*?\bslotChannels,\s*slotId,/g,
              count: 1,
            },
          ],
        },
        {
          name: 'observeStateDumpCoercions',
          callers: [
            {
              file,
              pattern: /observeStateDumpCoercions\([^;]*?\bslotChannels, slotId\);/g,
              count: 1,
            },
          ],
        },
      ],
    },
  ];
}

function setToolsSites(): Site[] {
  const file = 'tools/set-tools.ts';
  const forSlotThen = (rest: string): RegExp =>
    new RegExp('state\\.channels\\s*\\.forSlot\\(slotId\\)\\s*\\.publish\\(' + rest, 'g');
  return [
    {
      event: 'set_aborted_by_mode_revert',
      category: 'forSlot',
      pattern: forSlotThen('\\s*buildSetAbortedByModeRevertPayload\\('),
      count: 1,
    },
    {
      event: 'set_updated',
      category: 'forSlot',
      pattern: forSlotThen('buildSetUpdatedPayload\\('),
      count: 1,
    },
    { event: 'set_started', category: 'forSlot', pattern: forSlotThen('payload\\)'), count: 2 },
    {
      event: 'set_ended',
      category: 'forSlot',
      pattern: /slotChannels\.publish\(payload\)/g,
      count: 1,
    },
    {
      event: 'bilateral_divergence',
      category: 'forSlot',
      pattern: /slotChannels\.publish\(buildBilateralDivergencePayload\(/g,
      count: 1,
    },
    {
      event: 'rep_finalized (terminal rep)',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(buildRepFinalizedPayload\\('),
      count: 1,
      helpers: [
        {
          name: 'publishTerminalRepFinalized',
          callers: [
            { file, pattern: /publishTerminalRepFinalized\([^;]*?\bslotChannels,/g, count: 1 },
          ],
        },
      ],
    },
    {
      event: 'weight_implied_mismatch',
      category: 'scoped-param',
      pattern: bare('\\.publish\\(buildWeightImpliedMismatchPayload\\('),
      count: 1,
      helpers: [
        {
          name: 'publishWeightImpliedMismatch',
          callers: [
            {
              file,
              pattern: /publishWeightImpliedMismatch\(stored, slotId, slotChannels\)/g,
              count: 1,
            },
          ],
        },
      ],
    },
  ];
}

function voiceToolsSites(): Site[] {
  return [
    {
      event: 'deterministic_stop_unavailable',
      category: 'embeds-slot',
      pattern: bare('\\.publish\\(\\s*buildDeterministicStopUnavailablePayload\\('),
      count: 1,
    },
    {
      event: 'voice_input_failed (safety unload)',
      category: 'embeds-slot',
      pattern: bare('\\.publish\\(safetyUnloadFailedPayload\\(f\\.error, f\\.verdict\\.slot\\)\\)'),
      count: 2,
    },
    {
      event: 'deterministic_stop_triggered',
      category: 'embeds-slot',
      pattern: bare('\\.publish\\(\\s*buildDeterministicStopTriggeredPayload\\('),
      count: 1,
    },
    {
      event: 'voice_input',
      category: 'slot-free',
      pattern: bare('\\.publish\\(\\s*buildVoiceInputPayload\\('),
      count: 2,
    },
    {
      event: 'voice_input_failed',
      category: 'slot-free',
      pattern: bare(
        "\\.publish\\(\\{\\s*meta: \\{\\s*source: 'voltras',\\s*event_type: 'voice_input_failed'",
      ),
      count: 1,
    },
  ];
}

function isSourceFile(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

function walkSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : walkSources(join(dir, entry.name));
    }
    return isSourceFile(entry.name) ? [join(dir, entry.name)] : [];
  });
}

const SOURCES = new Map(
  walkSources(SRC_DIR).map((path) => [relative(SRC_DIR, path), readFileSync(path, 'utf8')]),
);

function sourceOf(file: string): string {
  const source = SOURCES.get(file);
  if (source === undefined)
    throw new Error(`${file}: listed in this test but not found under src/`);
  return source;
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function countOccurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

function expectPin(pin: Pin, what: string): void {
  const actual = countMatches(sourceOf(pin.file), pin.pattern);
  if (actual !== pin.count) {
    throw new Error(
      `${pin.file}: expected ${pin.count} match(es) of ${what} (${pin.pattern}), found ${actual}.`,
    );
  }
}

/** A method helper is counted by method name and a channels argument, whatever the receiver is called. */
function methodCallPattern(method: string): RegExp {
  return new RegExp(`\\.${method}\\([^)]*hannels\\b`, 'g');
}

function callerCountAcrossSrc(name: string): number {
  const method = name.split('.').at(-1) ?? name;
  const definition = `function ${method}(`;
  const isMethod = name.includes('.');
  let total = 0;
  for (const source of SOURCES.values()) {
    total += isMethod
      ? countMatches(source, methodCallPattern(method))
      : countOccurrences(source, `${name}(`) - countOccurrences(source, definition);
  }
  return total;
}

function docsSlotFreeEvents(): string[] {
  const doc = readFileSync(PUSH_EVENTS_DOC, 'utf8');
  const start = doc.indexOf('reach a consumer with no `slot` key at all');
  if (start < 0) throw new Error('docs/push-events.md: slot-exception list heading not found');
  const lines = doc.slice(start).split('\n').slice(1);
  const firstBullet = lines.findIndex((line) => line.startsWith('- '));
  const events: string[] = [];
  for (const line of lines.slice(firstBullet)) {
    if (line.startsWith('- ')) events.push(/^- `([^`]+)`/.exec(line)?.[1] ?? line);
    else if (line.trim() === '') break;
  }
  return events;
}

const ALL_SITES = Object.entries(SITES).flatMap(([file, sites]) =>
  sites.map((site) => ({ file, site })),
);

describe('channel publish-site inventory (VW-686)', () => {
  it('every source file under src/ with a .publish( call is in the inventory', () => {
    const unlisted = [...SOURCES]
      .filter(([file, source]) => source.includes('.publish(') && !(file in SITES))
      .map(([file]) => file);
    expect(unlisted, `unlisted file(s) publish on a channel: ${unlisted.join(', ')}`).toEqual([]);
  });

  for (const [file, sites] of Object.entries(SITES)) {
    it(`${file}: every .publish( occurrence is a listed site`, () => {
      for (const site of sites)
        expectPin({ file, pattern: site.pattern, count: site.count }, site.event);
      const listed = sites.reduce((sum, site) => sum + site.count, 0);
      const actual = countOccurrences(sourceOf(file), '.publish(');
      if (actual !== listed) {
        throw new Error(
          `${file}: found ${actual} .publish( occurrence(s) but the inventory lists ${listed}. ` +
            'Add the new site with its category; a slot-free one also goes in docs/push-events.md.',
        );
      }
    });
  }

  it('every site pattern matches the publish expression itself', () => {
    const loose = ALL_SITES.filter(({ site }) => !site.pattern.source.includes('\\.publish\\('));
    expect(loose.map(({ file, site }) => `${file}: ${site.event}`)).toEqual([]);
  });

  it('every forSlot local is bound to a slot-scoped publisher', () => {
    for (const binding of BINDINGS) expectPin(binding, 'the forSlot binding');
  });

  it('every caller of a scoped-param helper is pinned and passes a slot-scoped publisher', () => {
    const helpers = ALL_SITES.flatMap(({ site }) => site.helpers ?? []);
    for (const helper of helpers) {
      for (const caller of helper.callers) expectPin(caller, `a scoped call to ${helper.name}`);
      const pinned = helper.callers.reduce((sum, caller) => sum + caller.count, 0);
      const actual = callerCountAcrossSrc(helper.name);
      if (actual !== pinned) {
        throw new Error(
          `${helper.name}: ${actual} call(s) under src/ but ${pinned} pinned; pin the new caller.`,
        );
      }
    }
  });

  it('only the documented slot-free events publish without a slot', () => {
    const slotFree = new Set(
      ALL_SITES.filter(({ site }) => site.category === 'slot-free').map(({ site }) => site.event),
    );
    expect([...slotFree].sort()).toEqual([...SLOT_FREE_EVENTS].sort());
  });

  it("docs/push-events.md's slot-exception list matches the slot-free allowlist", () => {
    expect([...docsSlotFreeEvents()].sort()).toEqual([...SLOT_FREE_EVENTS].sort());
  });
});
