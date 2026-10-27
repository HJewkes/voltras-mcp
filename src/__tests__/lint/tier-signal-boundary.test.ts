// VW-813: analytics, plan and profile name a tier through `src/profile/tier.ts`,
// never `src/tools/tier-signal.ts`. Unlike the VW-362 analytics rule, a type-only
// import counts too: the point is that these layers do not depend on the tool
// that derives the tier, even at compile time.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectImports } from './import-boundary.js';

const SRC_DIR = join(import.meta.dirname, '..', '..');

function tierSignalImporters(layer: string): string[] {
  return collectImports(join(SRC_DIR, layer))
    .filter((ref) => /(^|\/)tools\/tier-signal(\.js)?$/.test(ref.specifier))
    .map((ref) => `${layer}/${ref.file}: '${ref.specifier}'`);
}

describe('tier-signal import boundary', () => {
  it.each(['analytics', 'plan', 'profile'])(
    'no non-test file in src/%s imports tools/tier-signal',
    (layer) => {
      expect(tierSignalImporters(layer)).toEqual([]);
    },
  );
});
