// The guard is the only thing between a public docs site and a confidentiality
// commitment made to a hardware vendor, so it is tested against SPELLINGS, not
// against the specific tokens that happen to be in the source today.
//
// Every fixture below is synthetic. Naming a real register here would put it in
// the repo, which is the thing the guard exists to prevent.

import { describe, it, expect } from 'vitest';
import { createProtocolGuard, normalizeIdentifier } from '../../docs/protocol-guard.js';

/** A vocabulary shaped like a real one: tool names, params, result fields. */
const VOCABULARY = [
  'device.set_weight',
  'device',
  'set_weight',
  'slot',
  'lbs',
  'overloadLbs',
  'rep_finalized',
  'tonnageLbs',
  'WeightTraining',
];

const guard = createProtocolGuard(VOCABULARY);

function kinds(text: string): string[] {
  return guard.find(text).map((match) => match.kind);
}

function tokens(text: string): string[] {
  return guard.find(text).map((match) => match.token);
}

describe('normalization', () => {
  // The whole design rests on this: one register, one normalized form, however
  // someone spells it. If these drift apart the vocabulary check is decorative.
  it('collapses case and every separator to one form', () => {
    const spellings = [
      'XR_PROBE_LATCH',
      'xr_probe_latch',
      'XR.PROBE.LATCH',
      'xr.probe.latch',
      'XR-PROBE-LATCH',
      'xrProbeLatch',
      'XrProbeLatch',
    ];
    const normalized = new Set(spellings.map(normalizeIdentifier));
    expect([...normalized]).toEqual(['xrprobelatch']);
  });
});

describe('register-name spellings', () => {
  it.each([
    ['screaming snake', 'Writes XR_PROBE_LATCH before the trigger.'],
    ['lowercase snake', 'Writes xr_probe_latch before the trigger.'],
    ['dotted upper', 'Writes XR.PROBE.LATCH before the trigger.'],
    ['dotted lower', 'Writes xr.probe.latch before the trigger.'],
    ['all-caps hyphenated', 'Writes XR-PROBE-LATCH before the trigger.'],
    ['camelCase run-together', 'Writes xrProbeLatch before the trigger.'],
    ['PascalCase run-together', 'Writes XrProbeLatch before the trigger.'],
  ])('flags the %s spelling', (_label, text) => {
    expect(kinds(text)).toContain('register-name');
  });

  it('redacts every spelling to the same marker', () => {
    const redacted = guard.redact('XR_PROBE_LATCH and xrProbeLatch and XR.PROBE.LATCH');
    expect(redacted.count).toBe(3);
    expect(redacted.text).toBe('[redacted] and [redacted] and [redacted]');
  });
});

describe('hex shapes', () => {
  it.each([
    ['lowercase prefixed', 'the opcode 0xa9 fires', 'hex-literal'],
    ['uppercase prefixed', 'the opcode 0xA9 fires', 'hex-literal'],
    ['bare lowercase run', 'the opcode a9c7 fires', 'bare-hex'],
    ['bare uppercase run', 'the opcode A9C7 fires', 'bare-hex'],
    ['bare mixed run', 'the opcode a9C7 fires', 'bare-hex'],
    ['spaced byte sequence', 'writes a9 c7 00 04 back to back', 'byte-sequence'],
    ['hyphenated byte sequence', 'writes a9-c7-00-04 back to back', 'byte-sequence'],
  ])('flags a %s', (_label, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it('ignores hex-shaped runs that carry no letter or no digit', () => {
    expect(kinds('2026 reps and the deadbeef cut')).toEqual([]);
  });
});

describe('the public surface passes', () => {
  it('lets tool names, parameters and result fields through', () => {
    const text =
      'Call `device.set_weight` with `lbs` and `slot`; the result carries ' +
      '`tonnageLbs` and `overloadLbs`, and `rep_finalized` fires per rep.';
    expect(tokens(text)).toEqual([]);
  });

  it('lets any casing of a public identifier through', () => {
    expect(tokens('DEVICE.SET_WEIGHT and deviceSetWeight and device_set_weight')).toEqual([]);
  });

  it('lets documented environment variables through by prefix', () => {
    expect(tokens('Set VMCP_DASHBOARD_PORT=off and VOLTRA_ADAPTER=mock.')).toEqual([]);
  });

  it('does not mistake dates, ticket ids, versions or filenames for identifiers', () => {
    expect(tokens('Validated 2026-05-06 under VW-168a against 0.3.x, see device-tools.ts')).toEqual(
      [],
    );
  });

  it('does not flag ordinary hyphenated prose', () => {
    expect(tokens('A read-only, best-effort back-fill of the self-report.')).toEqual([]);
  });
});
