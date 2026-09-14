// The "never ask for a measurement" rule, made executable (VW-364).
//
// The human decision on 2026-09-13/14 was that this server records what a
// lifter volunteers and NEVER asks them to go and get measured: no prompt, no
// reminder, no interval rule. VW-370 §11.3 is the evidence behind it — the
// operative clinical signals are bodyweight and waist (C32, C33, C34), so a
// referral would be asking for a number nothing here reads.
//
// That rule lives in prose, which no type and no lint rule can enforce. This
// file is the grep that can: it scans the VW-364 surfaces for the phrasings a
// prompt would be written in, and fails on any of them. It reads the files off
// disk rather than importing them, because a tool DESCRIPTION is a string the
// model acts on and is exactly where such a line would land.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every file VW-364 wrote or extended with lifter-facing wording. */
const GUARDED_FILES = [
  'analytics/body-fat-sources.ts',
  'store/leanness-band.ts',
  'schemas/profile.ts',
  'tools/profile-tools.ts',
];

/**
 * Phrasings that would turn a record into a request. Deliberately the exact
 * three the ticket names, kept as one alternation so a reader can see the whole
 * rule at once.
 */
const FORBIDDEN = /request a measurement|schedule a DEXA|cadence/i;

describe('the no-request rule', () => {
  for (const file of GUARDED_FILES) {
    it(`does not ask for a measurement in ${file}`, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      const offender = FORBIDDEN.exec(text);
      expect(
        offender === null ? null : `${file}: ${offender[0]}`,
        'this server records readings; it never asks for one',
      ).toBeNull();
    });
  }
});
