import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('prepack guard', () => {
  it('compiles the server, then rebuilds the dashboard, then checks the bundle', () => {
    const steps = pkg.scripts.prepack?.split('&&').map((s) => s.trim());
    expect(steps).toEqual([
      'npm run clean',
      'npm run build',
      'npm run build:dashboard',
      'node scripts/check-spa-bundle.mjs --absent dist/spa',
    ]);
  });

  it('removes dist with a cross-platform script before compiling', () => {
    expect(pkg.scripts.clean).toContain('rmSync');
    expect(pkg.scripts.clean).toContain("'dist'");
    expect(pkg.scripts.clean).not.toMatch(/\brm\b -/);
  });

  it('compiles through a build config that leaves out every __tests__ directory', () => {
    expect(pkg.scripts.build).toContain('tsc -p tsconfig.build.json');
    const build = JSON.parse(
      readFileSync(new URL('../../tsconfig.build.json', import.meta.url), 'utf8'),
    ) as { extends: string; exclude: string[] };
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.exclude).toContain('**/__tests__/**');
  });

  it('keeps the tests inside the config that typecheck uses', () => {
    const base = JSON.parse(
      readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8'),
    ) as { exclude: string[] };
    expect(base.exclude).not.toContain('**/__tests__/**');
  });
});
