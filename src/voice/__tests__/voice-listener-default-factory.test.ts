// Regression guard for VMCP-02.38: `system.listen_start` threw
// `LISTENER_START_FAILED: require is not defined`. voice-listener.ts is ESM
// (`"type": "module"`) but uses CommonJS `require` for the lazy native loads
// (`node-record-lpcm16`, `nodejs-whisper`). The bare `require` global is
// undefined under ESM, so the fix reconstructs it via
// `createRequire(import.meta.url)` (mirroring `tools/server-tools.ts`).
//
// Why a static source guard rather than a behavioral test: a `createRequire`
// `require` bypasses vitest's module mocker (confirmed — `vi.mock` does not
// intercept it), so exercising `defaultAudioFactory()` loads the real native
// module and spawns sox. There is no side-effect-free way to drive the lazy
// require, so this guard asserts the wiring is present — it fails if the fix
// is reverted, catching the regression here instead of only on hardware.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('voice-listener ESM require wiring (VMCP-02.38)', () => {
  const src = readFileSync(fileURLToPath(new URL('../voice-listener.ts', import.meta.url)), 'utf8');

  it('imports createRequire from node:module', () => {
    expect(src).toContain("import { createRequire } from 'node:module'");
  });

  it('reconstructs require via createRequire(import.meta.url) before any require() call', () => {
    const wiringIndex = src.search(/const require = createRequire\(import\.meta\.url\)/);
    expect(wiringIndex).toBeGreaterThan(-1);
    // Every `require('...')` call must come after the createRequire wiring,
    // so the bare ESM `require` global is never referenced.
    const firstRequireCall = src.search(/\brequire\(['"][^'"]+['"]\)/);
    expect(firstRequireCall).toBeGreaterThan(wiringIndex);
  });
});
