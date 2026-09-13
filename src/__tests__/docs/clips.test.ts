// The staleness gate for the published screen recordings.
//
// A stale clip is strictly worse than a stale screenshot. A reader skims a still
// and notices it looks wrong; nobody notices a 35-second video is lying until
// they have watched 35 seconds. So the gate that w4-08 put around the stills has
// to reach the clips too, or the site looks covered where it is not.
//
// `npm run docs:captures` needs a browser, ffmpeg and a local TTS python, so it
// cannot run in CI any more than the screenshot half can. What CI CAN do is hold
// the committed clips to the committed definition AND to the committed narration
// scripts — which is the specific way a video rots: the flow changes, the script
// is edited to match, and the audio still says the old thing.
//
// It does NOT compare pixels or decode the video. There is no ffmpeg in CI, and
// two encodes of a page that paints a wall clock never agree anyway. What is
// asserted is everything around the frames: the manifest agrees with the
// definition, every clip is on disk as a real MP4 at the recorded size, its
// narration audio is there, its narration hash still matches the script beside
// the guide, the sampled frames it recorded were substantial and distinct, and
// every guide that embeds a clip says the narration is synthetic.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'; // prettier-ignore
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolGuard } from '../../docs/protocol-guard.js';
import { CAPTURE_MANIFEST } from '../../docs/capture-shots.js';
import {
  CAPTURE_CLIPS,
  CLIP_DIR,
  CLIP_DURATION_TOLERANCE_S,
  CLIP_FPS,
  CLIP_MAX_BYTES,
  CLIP_SIZE,
  NARRATION_DIR,
  NARRATION_HEADROOM_MS,
  SYNTHETIC_NARRATION_NOTICE,
  clipDefinitionHash,
  narrationHash,
  narrationText,
} from '../../docs/capture-clips.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLIPS = join(REPO_ROOT, CLIP_DIR);
const SITE_DIR = join(REPO_ROOT, 'site');
const REGENERATE = 'run `npm run docs:captures` and commit the result';

interface ManifestFrame {
  readonly atSeconds: number;
  readonly bytes: number;
  readonly sha256: string;
}

interface ManifestClip {
  readonly name: string;
  readonly scenario: string;
  readonly route: string;
  readonly caption: string;
  readonly file: string;
  readonly narrationFile: string;
  readonly narrationAudio: string;
  readonly narrationHash: string;
  readonly narrationSeconds: number;
  readonly startWhen: unknown;
  readonly endWhen: unknown;
  readonly assertedText: readonly string[];
  readonly assertedValues: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
  readonly bytes: number;
  readonly frames: readonly ManifestFrame[];
  readonly sha256: string;
}

interface Manifest {
  readonly clipDefinitionHash: string;
  readonly clipSize: { readonly width: number; readonly height: number };
  readonly clipFps: number;
  readonly clips: readonly ManifestClip[];
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, CAPTURE_MANIFEST), 'utf8')) as Manifest;
const byName = new Map(manifest.clips.map((clip) => [clip.name, clip]));

/** The major brand out of an ISO base-media file's `ftyp` box, so no demuxer is needed. */
function isoBrand(file: string): string {
  const header = Buffer.alloc(12);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, header, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  expect(header.subarray(4, 8).toString('ascii'), `${file} has no ftyp box`).toBe('ftyp');
  return header.subarray(8, 12).toString('ascii');
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

describe('the clip manifest tracks the clip definition', () => {
  it('was written by the definition that is checked in now', () => {
    expect(manifest.clipDefinitionHash, REGENERATE).toBe(clipDefinitionHash());
  });

  it('holds one entry per declared clip, in declaration order, and no others', () => {
    expect(manifest.clips.map((clip) => clip.name)).toEqual(CAPTURE_CLIPS.map((clip) => clip.name));
  });

  it('records the geometry the definition asks for', () => {
    expect(manifest.clipSize).toEqual({ ...CLIP_SIZE });
    expect(manifest.clipFps).toBe(CLIP_FPS);
  });

  it.each(CAPTURE_CLIPS.map((clip) => [clip.name, clip] as const))(
    '%s was recorded from the route, predicates and assertions it declares',
    (_name, clip) => {
      const entry = byName.get(clip.name);
      expect(entry, REGENERATE).toBeDefined();
      expect(entry?.scenario).toBe(clip.scenario);
      expect(entry?.route).toBe(clip.route);
      expect(entry?.caption).toBe(clip.caption);
      // Both ends, not just one: a clip recorded against a weaker start predicate
      // opens on a page that had no data yet, and one recorded against a weaker
      // end predicate stops before the stage it was taken for.
      expect(entry?.startWhen).toEqual(clip.startWhen);
      expect(entry?.endWhen).toEqual(clip.endWhen);
      expect(entry?.assertedText).toEqual([...clip.expectText]);
      expect(entry?.assertedValues).toEqual([...clip.expectValues]);
      expect(entry?.narrationFile).toBe(clip.narrationFile);
    },
  );

  it('pins at least one computed value on every clip', () => {
    const unpinned = CAPTURE_CLIPS.filter((clip) => clip.expectValues.length === 0);
    expect(unpinned.map((clip) => clip.name)).toEqual([]);
  });
});

describe('the narration script is the source of the audio', () => {
  // The single most important assertion in this file. Everything else catches a
  // definition edited without a re-render; this catches the one that actually
  // happens — prose edited to match a changed flow, with the audio left saying
  // the old thing, which nothing else in the build would ever notice.
  it.each(CAPTURE_CLIPS.map((clip) => [clip.name, clip] as const))(
    '%s was voiced from the script that is checked in now',
    (_name, clip) => {
      const script = join(REPO_ROOT, NARRATION_DIR, clip.narrationFile);
      expect(existsSync(script), `${script} missing`).toBe(true);
      const spoken = narrationText(readFileSync(script, 'utf8'));
      expect(spoken.length, `${clip.narrationFile} is empty`).toBeGreaterThan(0);
      expect(byName.get(clip.name)?.narrationHash, `${clip.narrationFile} changed — ${REGENERATE}`) //
        .toBe(narrationHash(spoken));
    },
  );

  it.each(CAPTURE_CLIPS.map((clip) => [clip.name] as const))(
    '%s ships its narration as its own track, ending before the video does',
    (name) => {
      const entry = byName.get(name);
      const audio = join(REPO_ROOT, CLIP_DIR, '..', entry?.narrationAudio ?? '');
      expect(existsSync(audio), `${audio} missing — ${REGENERATE}`).toBe(true);
      expect(isoBrand(audio)).toBe('M4A ');
      // The mux stream-copies the audio and never pads it, so a narration that
      // overran would be a word cut off mid-sentence in a published video.
      const headroom = (entry?.seconds ?? 0) - (entry?.narrationSeconds ?? 0);
      expect(headroom).toBeGreaterThanOrEqual(NARRATION_HEADROOM_MS / 1000);
    },
  );
});

describe('the clips on disk', () => {
  it.each(CAPTURE_CLIPS.map((clip) => [clip.name, clip] as const))(
    '%s is a real MP4 at the recorded size and length',
    (name, clip) => {
      const entry = byName.get(name);
      const file = join(CLIPS, `${name}.mp4`);
      expect(existsSync(file), `${file} missing — ${REGENERATE}`).toBe(true);
      expect(isoBrand(file)).toBe('isom');
      // The bytes on disk against the bytes recorded: no decoder needed, and a
      // file swapped or truncated after the fact cannot survive it.
      expect(statSync(file).size, REGENERATE).toBe(entry?.bytes);
      expect(entry?.bytes).toBeLessThanOrEqual(CLIP_MAX_BYTES);
      expect({ width: entry?.width, height: entry?.height }).toEqual({ ...CLIP_SIZE });
      expect(entry?.fps).toBe(CLIP_FPS);
      // A band, not a number: both ends are predicates, so poll granularity and
      // page mount move the length by a fraction of a second every run. Narrow
      // enough that a clip which collapsed to its lead-out, or ran away with a
      // stuck driver, is red.
      expect(entry?.seconds).toBeGreaterThan(clip.nominalSeconds - CLIP_DURATION_TOLERANCE_S);
      expect(entry?.seconds).toBeLessThan(clip.nominalSeconds + CLIP_DURATION_TOLERANCE_S);
    },
  );

  it.each(CAPTURE_CLIPS.map((clip) => [clip.name] as const))(
    '%s recorded substantial, distinct sampled frames',
    (name) => {
      const frames = byName.get(name)?.frames ?? [];
      expect(frames.length, REGENERATE).toBeGreaterThanOrEqual(3);
      // The proof a still gets free from its own file size: a clip that recorded
      // a blank stage, or froze on frame one, encodes and plays back cleanly.
      for (const frame of frames) expect(frame.bytes).toBeGreaterThan(20_000);
      expect(new Set(frames.map((frame) => frame.sha256)).size).toBe(frames.length);
    },
  );

  it('holds nothing the definition does not declare', () => {
    const expected = CAPTURE_CLIPS.flatMap((clip) => [
      `${clip.name}.mp4`,
      `${clip.name}.narration.m4a`,
    ]).sort();
    expect(readdirSync(CLIPS).sort()).toEqual(expected);
  });
});

describe('the clips are safe to publish', () => {
  // Same filter as the stills' guard test: a vocabulary-free guard flags any
  // ALL-CAPS hyphenated token, which the dual clip legitimately asserts
  // (`MOCK-VOLTRA-LEFT`, the mock adapter's synthetic device label).
  const LITERAL_KINDS = new Set(['hex-literal', 'bare-hex', 'byte-sequence']);
  const guard = createProtocolGuard([]);

  it('names, captions, assertions and narration carry no protocol detail', () => {
    const offenders: string[] = [];
    for (const clip of CAPTURE_CLIPS) {
      const script = join(REPO_ROOT, NARRATION_DIR, clip.narrationFile);
      const text = [
        clip.name,
        clip.caption,
        clip.route,
        ...clip.expectText,
        ...clip.expectValues,
        existsSync(script) ? readFileSync(script, 'utf8') : '',
      ].join('\n');
      for (const match of guard.find(text)) {
        if (LITERAL_KINDS.has(match.kind)) offenders.push(`${clip.name}: ${match.kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('drives every clip against a mock scenario, never a real device', () => {
    const scenarios = new Set(CAPTURE_CLIPS.map((clip) => clip.scenario));
    expect([...scenarios].sort()).toEqual(['dual-clip', 'planned-clip']);
  });
});

describe('the docs site says what it is showing', () => {
  it.each(CAPTURE_CLIPS.map((clip) => [clip.name, clip] as const))(
    '%s is embedded on its guide, which states the narration is synthetic',
    (name, clip) => {
      const guide = join(REPO_ROOT, clip.guide);
      expect(existsSync(guide), `${clip.guide} missing`).toBe(true);
      const body = readFileSync(guide, 'utf8');
      expect(body).toContain(`/captures/clips/${name}.mp4`);
      // Synthetic narration is a deliberate choice, and a reader is owed it.
      expect(body, `${clip.guide} must carry the synthetic-narration notice`).toContain(
        SYNTHETIC_NARRATION_NOTICE,
      );
      // The script itself is linked, so "edit it and re-run" is discoverable
      // from the page rather than only from the harness doc.
      expect(body).toContain(clip.narrationFile);
    },
  );

  it('resolves every /captures/clips/*.mp4 a site page references', () => {
    const declared = new Set(CAPTURE_CLIPS.map((clip) => `${clip.name}.mp4`));
    const dangling: string[] = [];
    for (const page of sitePages()) {
      const body = readFileSync(page, 'utf8');
      for (const match of body.matchAll(/\/captures\/clips\/([\w.-]+\.mp4)/g)) {
        if (!declared.has(match[1])) dangling.push(`${page}: ${match[1]}`);
      }
    }
    expect(dangling, REGENERATE).toEqual([]);
  });
});
