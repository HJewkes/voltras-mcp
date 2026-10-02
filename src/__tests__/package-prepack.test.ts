import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('prepack guard', () => {
  it('rebuilds the production dashboard before checking the bundle', () => {
    const steps = pkg.scripts.prepack?.split('&&').map((s) => s.trim());
    expect(steps).toEqual([
      'npm run build:dashboard',
      'node scripts/check-spa-bundle.mjs --absent dist/spa',
    ]);
  });
});
