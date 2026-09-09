// Static guard over the `.publish(...)` call sites in the three tool files
// that publish outside any slot-scoped flow (VW-195, follow-up to PR #267).
//
// None of `voice-tools.ts`, `timer-tools.ts`, or `debug-tools.ts` ever calls
// `.forSlot(...)` — voice input, timers, and the debug probe aren't addressed
// to a device slot the way `set.*`/`session.*` are. So whether an event
// carries `meta.slot` depends entirely on what its payload builder embeds,
// not on the publisher. This test pins the exact, known set of call sites in
// these three files by content (not just by count), so a NEW `.publish(...)`
// call added to any of them — without a matching entry here — fails loudly
// and names the file, instead of silently reaching the transport unaccounted
// for, which is exactly how the original VW-195 bug went unnoticed.
//
// This guard is deliberately scoped to the three files this ticket owns.
// `set-tools.ts`, `device-tools.ts`, and `channel-payloads.ts` also publish
// outside `.forSlot(...)` (`voice_input`, `voltras_available`,
// `bilateral_divergence`, `weight_implied_mismatch`) — known, pre-existing,
// and tracked as a separate follow-up rather than fixed or guarded here.
//
// Known call sites in this scope and why each one is safe:
//  - voice-tools.ts: `deterministic_stop_unavailable`, the two
//    `voice_input_failed` (SAFETY_UNLOAD_FAILED) sites, and
//    `deterministic_stop_triggered` all embed `slot` themselves (the last
//    two unconditionally, the first only when exactly one slot was
//    evaluated). The two `voice_input` sites never resolve a slot, by
//    design. All of these have their slot-presence pinned in
//    voice-tools.test.ts's "Tier-A safety fast-path" and "channel events"
//    suites.
//  - voice-tools.ts's `onError` handler (`voice_input_failed`),
//    timer-tools.ts's `timer_complete`, and debug-tools.ts's
//    `debug.push_test_channel` probe are the three documented slot-absent
//    exceptions this ticket introduced `at` for; see docs/push-events.md.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS_DIR = join(__dirname, '..');

function countOccurrences(source: string, substring: string): number {
  return source.split(substring).length - 1;
}

interface Marker {
  /** What this call site publishes, for the failure message. */
  label: string;
  /** A substring unique to this call site within the file. */
  substring: string;
  /** How many call sites this substring is expected to match. */
  count: number;
}

interface FileExpectation {
  file: string;
  totalPublishCalls: number;
  markers: Marker[];
}

const EXPECTATIONS: FileExpectation[] = [
  {
    file: 'voice-tools.ts',
    totalPublishCalls: 7,
    markers: [
      {
        label: 'deterministic_stop_unavailable',
        substring: 'buildDeterministicStopUnavailablePayload(',
        count: 1,
      },
      {
        label: 'voice_input_failed / SAFETY_UNLOAD_FAILED (two call sites)',
        substring: 'safetyUnloadFailedPayload(f.error',
        count: 2,
      },
      {
        label: 'deterministic_stop_triggered',
        substring: 'buildDeterministicStopTriggeredPayload(',
        count: 1,
      },
      {
        label: 'voice_input (two call sites)',
        substring: 'buildVoiceInputPayload(',
        count: 2,
      },
      {
        label: 'voice_input_failed — listener onError (the VW-195 exception)',
        substring: 'Voice listener error:',
        count: 1,
      },
    ],
  },
  {
    file: 'timer-tools.ts',
    totalPublishCalls: 1,
    markers: [
      {
        label: 'timer_complete (the VW-195 exception)',
        substring: "event_type: 'timer_complete'",
        count: 1,
      },
    ],
  },
  {
    file: 'debug-tools.ts',
    totalPublishCalls: 1,
    markers: [
      {
        label: 'debug.push_test_channel probe (the VW-195 exception)',
        substring:
          'state.channels.publish({ content: input.content, meta: { ...input.meta, nonce } })',
        count: 1,
      },
    ],
  },
];

describe('channel publish-site inventory (VW-195 guard)', () => {
  for (const expectation of EXPECTATIONS) {
    it(`${expectation.file}: expectation table markers sum to the declared total`, () => {
      const markerTotal = expectation.markers.reduce((sum, m) => sum + m.count, 0);
      if (markerTotal !== expectation.totalPublishCalls) {
        throw new Error(
          `${expectation.file}: this test's own EXPECTATIONS table is inconsistent — ` +
            `markers sum to ${markerTotal} but totalPublishCalls is ${expectation.totalPublishCalls}.`,
        );
      }
      expect(markerTotal).toBe(expectation.totalPublishCalls);
    });

    it(`${expectation.file}: has exactly the known .publish(...) call sites`, () => {
      const source = readFileSync(join(TOOLS_DIR, expectation.file), 'utf8');

      for (const marker of expectation.markers) {
        const actual = countOccurrences(source, marker.substring);
        if (actual !== marker.count) {
          throw new Error(
            `${expectation.file}: expected ${marker.count} occurrence(s) of "${marker.label}" ` +
              `(matched via "${marker.substring}"), found ${actual}. If you added or removed a ` +
              `.publish(...) call for this event, update this test's EXPECTATIONS table and, if ` +
              `it carries no meta.slot, update docs/push-events.md's slot-exception list to match.`,
          );
        }
      }

      const actualTotal = countOccurrences(source, '.publish(');
      if (actualTotal !== expectation.totalPublishCalls) {
        throw new Error(
          `${expectation.file}: found ${actualTotal} total .publish(...) call site(s) but the ` +
            `known markers above only account for ${expectation.totalPublishCalls} — a new, ` +
            `unaccounted-for .publish(...) call was added to this file. Name it in this test's ` +
            `EXPECTATIONS table with its event type and slot behavior, and, if it carries no ` +
            `meta.slot, add it to docs/push-events.md's slot-exception list.`,
        );
      }
      expect(actualTotal).toBe(expectation.totalPublishCalls);
    });
  }
});
