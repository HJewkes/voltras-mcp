// The staleness gate for the published screenshots.
//
// `npm run docs:captures` needs a browser, so it cannot run here — CI has no
// chromium and this brief deliberately keeps the download out of `postinstall`.
// What CI CAN do is hold the committed captures to the committed definition,
// which is the half of "a screenshot rots silently" that is actually decidable.
//
// It does NOT compare pixels. Font hinting, GPU rasterisation and Skia's
// antialiasing differ per machine, and the dashboard paints a wall clock and a
// count-up rest timer, so no two runs agree even on one machine. A comparison
// that cannot fail is worse than no comparison, so what is asserted is
// everything around the pixels: the manifest agrees with the definition, every
// declared shot is on disk at the declared geometry, each capture recorded the
// assertions it had to satisfy, nothing extra is sitting in the directory, and
// no site page links a capture that no longer exists.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolGuard } from '../../docs/protocol-guard.js';
import {
  CAPTURE_DIR,
  CAPTURE_MANIFEST,
  CAPTURE_SHOTS,
  CAPTURE_VIEWPORT,
  CAPTURE_DEVICE_SCALE_FACTOR,
  captureDefinitionHash,
} from '../../docs/capture-shots.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CAPTURES = join(REPO_ROOT, CAPTURE_DIR);
const SITE_DIR = join(REPO_ROOT, 'site');
const REGENERATE = 'run `npm run docs:captures` and commit the result';

interface ManifestShot {
  readonly name: string;
  readonly scenario: string;
  readonly route: string;
  readonly caption: string;
  readonly file: string;
  readonly waitFor: unknown;
  readonly assertedText: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
}

interface Manifest {
  readonly definitionHash: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly shots: readonly ManifestShot[];
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, CAPTURE_MANIFEST), 'utf8')) as Manifest;
const byName = new Map(manifest.shots.map((shot) => [shot.name, shot]));

/** Width and height out of the PNG's IHDR, so no image library is needed. */
function pngDimensions(file: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, header, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  expect(header.subarray(0, 8).toString('hex'), `${file} is not a PNG`).toBe('89504e470d0a1a0a');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Every markdown page under `site/`, excluding VitePress build output. */
function sitePages(dir = SITE_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'cache' || entry.name === 'public') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sitePages(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

describe('the capture manifest tracks the capture definition', () => {
  it('was written by the definition that is checked in now', () => {
    expect(manifest.definitionHash, REGENERATE).toBe(captureDefinitionHash());
  });

  it('holds one entry per declared shot, in declaration order, and no others', () => {
    expect(manifest.shots.map((shot) => shot.name)).toEqual(CAPTURE_SHOTS.map((shot) => shot.name));
  });

  it('records the geometry the definition asks for', () => {
    expect(manifest.viewport).toEqual({ ...CAPTURE_VIEWPORT });
    expect(manifest.deviceScaleFactor).toBe(CAPTURE_DEVICE_SCALE_FACTOR);
  });

  it.each(CAPTURE_SHOTS.map((shot) => [shot.name, shot] as const))(
    '%s was captured from the route, state and assertions it declares',
    (_name, shot) => {
      const entry = byName.get(shot.name);
      expect(entry, REGENERATE).toBeDefined();
      expect(entry?.scenario).toBe(shot.scenario);
      expect(entry?.route).toBe(shot.route);
      expect(entry?.caption).toBe(shot.caption);
      expect(entry?.waitFor).toEqual(shot.waitFor);
      // The assertions are the only evidence a PNG is not blank, so a capture
      // taken against a weaker set than the definition declares is stale.
      expect(entry?.assertedText).toEqual([...shot.expectText]);
    },
  );
});

describe('the captures on disk', () => {
  it.each(CAPTURE_SHOTS.map((shot) => [shot.name] as const))('%s is a real PNG', (name) => {
    const entry = byName.get(name);
    const file = join(CAPTURES, `${name}.png`);
    expect(existsSync(file), `${file} missing — ${REGENERATE}`).toBe(true);
    const { width, height } = pngDimensions(file);
    expect({ width, height }).toEqual({
      width: CAPTURE_VIEWPORT.width * CAPTURE_DEVICE_SCALE_FACTOR,
      height: CAPTURE_VIEWPORT.height * CAPTURE_DEVICE_SCALE_FACTOR,
    });
    expect(entry?.width).toBe(width);
    expect(entry?.height).toBe(height);
    // A chrome-rendered dashboard page is tens of kB; a blank one is ~2 kB. This
    // is a floor against an empty render, not a content check — the assertions
    // the harness ran at capture time are what actually prove the content.
    expect(entry?.bytes).toBeGreaterThan(10_000);
  });

  it('holds nothing the definition does not declare', () => {
    const expected = [...CAPTURE_SHOTS.map((shot) => `${shot.name}.png`), 'manifest.json'].sort();
    expect(readdirSync(CAPTURES).sort()).toEqual(expected);
  });
});

describe('the captures are safe to publish', () => {
  // Same filter as the capability reference's own guard test: a vocabulary-free
  // guard flags any ALL-CAPS hyphenated token, which the dual shot legitimately
  // asserts (`MOCK-VOLTRA-LEFT`, the mock adapter's synthetic device label).
  // Byte literals, bare hex runs and byte sequences have no such excuse.
  const LITERAL_KINDS = new Set(['hex-literal', 'bare-hex', 'byte-sequence']);
  const guard = createProtocolGuard([]);

  it('names and captions no shot after protocol detail', () => {
    const offenders: string[] = [];
    for (const shot of CAPTURE_SHOTS) {
      const text = `${shot.name} ${shot.caption} ${shot.route}`;
      for (const match of guard.find(text)) {
        if (LITERAL_KINDS.has(match.kind)) offenders.push(`${shot.name}: ${match.kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('asserts on no string that reads as protocol detail', () => {
    const offenders: string[] = [];
    for (const shot of CAPTURE_SHOTS) {
      for (const match of guard.find(shot.expectText.join('\n'))) {
        if (LITERAL_KINDS.has(match.kind)) offenders.push(`${shot.name}: ${match.kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('drives every shot against a mock scenario, never a real device', () => {
    const scenarios = new Set(CAPTURE_SHOTS.map((shot) => shot.scenario));
    expect([...scenarios].sort()).toEqual(['cold', 'dual', 'planned']);
  });
});

describe('the docs site cannot link a capture that is gone', () => {
  it('resolves every /captures/*.png a site page references', () => {
    const declared = new Set(CAPTURE_SHOTS.map((shot) => `${shot.name}.png`));
    const dangling: string[] = [];
    for (const page of sitePages()) {
      const body = readFileSync(page, 'utf8');
      for (const match of body.matchAll(/\/captures\/([\w.-]+\.png)/g)) {
        if (!declared.has(match[1])) dangling.push(`${page}: ${match[1]}`);
      }
    }
    expect(dangling, REGENERATE).toEqual([]);
  });
});
