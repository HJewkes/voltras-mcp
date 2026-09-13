#!/usr/bin/env node
// Produce the docs site's dashboard screenshots AND its narrated screen
// recordings, headlessly, from two committed definitions
// (`src/docs/capture-shots.ts`, `src/docs/capture-clips.ts`).
//
// Usage:
//   npm run build && npm run build:dashboard
//   npm run docs:captures                            # every shot and every clip
//   npm run docs:captures -- --only live-rest        # re-take one shot
//   npm run docs:captures -- --record planned-set    # re-take one clip
//
// ── What a clip adds over a shot ───────────────────────────────────────────
// The same drivers, the same `/api/snapshot` predicates, the same page-text
// assertions — but bracketed differently. A shot waits for one state and asserts
// against one moment; a clip opens the page when a START predicate holds, keeps
// sampling the page text until an END predicate holds, and then asserts that
// every expected string appeared at some point WHILE the camera was running.
// A video that recorded a blank stage plays back without error, so the sampled
// frames are checked for size and for being distinct from one another too.
//
// The narration is synthetic on purpose. A script that lives in the repo beside
// the guide can be re-rendered when the flow changes; a human take cannot. See
// `src/docs/capture-clips.ts` and `docs/screenshot-harness.md`.
//
// ── How a shot is timed ────────────────────────────────────────────────────
// Every shot waits on a PREDICATE over `/api/snapshot` (the same JSON the SPA
// polls) rather than on a sleep. This is not a style preference: a dashboard
// that failed to mount, lost its stylesheet or rendered an empty stage
// screenshots perfectly cleanly and throws nothing, so a fixed delay would write
// a blank PNG and report success. After the predicate fires the script also
// WAITS for the shot's expected strings to be in the DOM, screenshots, then
// re-reads the DOM and fails if any of them has gone — the capture is bracketed
// by the assertion, not followed by it.
//
// ── What is asserted ───────────────────────────────────────────────────────
// Two kinds of string, both from `src/docs/capture-shots.ts`, both matched the
// same way: `expectText` (labels the markup hard-codes) proves the page is not
// blank, and `expectValues` (numbers the pipeline computed) proves it is not
// WRONG. Labels alone cannot catch a wrong number or a NaN — the panel is still
// there and still says `TONNAGE`.
//
// `expectValues` is only meaningful because the drivers can be pinned: each set
// is an exact burst of reps from a mock device parked before and after it, so
// the frame sequence reaching the analytics is identical run to run
// (scripts/lib/mock-burst.mjs). The inputs are fixed; the real SDK, event
// bridge, analytics and SPA all still run. Wall clocks, rest countdowns and
// anything derived from frame timestamps stay excluded — see the note on
// `expectValues` in the definition for exactly which fields and why.
//
// ── Isolation ──────────────────────────────────────────────────────────────
// Every run gets a fresh `VMCP_DB_PATH` under a temp directory that is deleted
// on exit, and a probed-free `VMCP_DASHBOARD_PORT`. The real store at
// `~/.voltras/vmcp.sqlite` is never opened: these images are published, and it
// holds real training history. `VMCP_DASHBOARD_PORT=0` is NOT the way to get an
// ephemeral port here — `resolveDashboardPort` (src/server.ts) reads `0` as
// "off" and the dashboard never binds at all.
//
// ── Browsers ───────────────────────────────────────────────────────────────
// `playwright-core` is the dependency, not `playwright`: it has no postinstall,
// so `npm ci` downloads no browser and CI stays untouched. Installing the
// browser is a documented one-time manual step (see docs/screenshot-harness.md).

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');
const SPA_INDEX = path.join(REPO_ROOT, 'dist/spa/index.html');
const DEFINITION = path.join(REPO_ROOT, 'dist/docs/capture-shots.js');
const CLIP_DEFINITION = path.join(REPO_ROOT, 'dist/docs/capture-clips.js');

/** How often the predicate re-reads `/api/snapshot`. Well under the SPA's own 2s poll. */
const POLL_MS = 250;
/**
 * Per-shot ceiling. The longest predicate (`sessions-ended`) waits out a whole
 * planned run — three exercises of two 12s sets with 10s rests, ~2 minutes — so
 * this is generous on purpose and only ever fires on a genuinely stuck run.
 */
const PREDICATE_TIMEOUT_MS = 300_000;
/**
 * Per-assertion ceiling for the DOM, deliberately far shorter than the state
 * predicate's. By the time this runs the predicate already holds, so the page
 * only has to finish its own 2s poll and paint. Giving it the predicate's five
 * minutes instead is actively harmful: a genuinely WRONG value never appears,
 * so the wait runs to the end of the whole scenario and the error then reports
 * the page as it looked minutes later, not as it looked when the value was
 * wrong.
 */
const TEXT_TIMEOUT_MS = 20_000;
/** How long the dashboard sidecar gets to bind after the driver starts. */
const DASHBOARD_BIND_TIMEOUT_MS = 60_000;
/**
 * Connection-level `fetch` retries per snapshot read. Three at {@link POLL_MS}
 * apart covers the intermittent reject a heavily loaded machine produces without
 * masking a sidecar that has actually gone away — the predicate's own timeout
 * still expires on schedule.
 */
const TRANSIENT_FETCH_RETRIES = 3;

const log = (...args) => console.error('[capture]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI ────────────────────────────────────────────────────────────────────

/**
 * `--only` narrows the stills, `--record` narrows the clips. Neither takes
 * everything; either one on its own takes just that thing, so re-taking one clip
 * never costs a four-minute screenshot run.
 */
function parseArgs(argv) {
  const args = { only: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--record') args.record = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Narrow one definition list. `name` names an entry in THIS list; `otherName` is
 * the sibling flag, and its presence is what turns "no flag for me" from "take
 * everything" into "take nothing" — so `--record` alone never costs a
 * four-minute screenshot run.
 */
function narrow(all, name, otherName, label) {
  if (name === null) return otherName === null ? all : [];
  const picked = all.filter((entry) => entry.name === name);
  if (picked.length === 0) {
    throw new Error(
      `${label} ${name} matches nothing; known: ${all.map((e) => e.name).join(', ')}`,
    );
  }
  return picked;
}

/** An OS-assigned free port, released immediately before we hand it to a child. */
function probeFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── the running dashboard ──────────────────────────────────────────────────

async function getJson(port, route) {
  // A connection-level failure is retried; an HTTP status is not. On a loaded
  // machine `fetch` to the sidecar intermittently rejects outright, and one of
  // those used to abort a six-minute run several scenarios in. A 500 is a real
  // answer from a server that is up, so retrying it would only hide it.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      if (!res.ok) throw new Error(`${route} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= TRANSIENT_FETCH_RETRIES || /^\S+ -> \d+$/.test(err.message)) throw err;
      await sleep(POLL_MS);
    }
  }
}

/** Reps on one slot as the dashboard sees them (`devices[].sets.active`), or null. */
function slotReps(snapshot, slot) {
  const entry = snapshot.devices?.find((d) => d.slotId === slot);
  const active = entry?.sets?.active ?? (slot === 'primary' ? snapshot.sets?.active : null);
  if (!active) return null;
  return active.reps?.length ?? active.repCount ?? 0;
}

/**
 * Evaluate one `waitFor` against the live server. Returns a `{ ok, detail }` pair
 * so a timeout can report what the state actually was instead of just "timed out".
 */
async function evaluateWait(port, waitFor) {
  const snapshot = await getJson(port, '/api/snapshot');
  switch (waitFor.kind) {
    case 'idle': {
      const connected = (snapshot.devices ?? []).some((d) => d.device?.connected);
      return {
        ok: snapshot.session === null && !connected,
        detail: `session=${snapshot.session ? 'open' : 'none'} connected=${connected}`,
      };
    }
    case 'set-open': {
      const counts = waitFor.reps.map(([slot, want]) => [slot, want, slotReps(snapshot, slot)]);
      return {
        ok: counts.every(([, want, reps]) => reps === want),
        detail: counts.map(([slot, want, reps]) => `${slot}=${reps ?? '—'}/${want}`).join(' '),
      };
    }
    case 'set-open-min': {
      // The clips' start anchor. A still lands on a parked device and so wants
      // an EXACT count; a clip has to open the page while reps are still
      // arriving, so it wants a floor — see `ClipWait` in `capture-clips.ts`.
      const counts = waitFor.reps.map(([slot, want]) => [slot, want, slotReps(snapshot, slot)]);
      return {
        ok: counts.every(([, want, reps]) => reps !== null && reps >= want),
        detail: counts.map(([slot, want, reps]) => `${slot}=${reps ?? '—'}/${want}+`).join(' '),
      };
    }
    case 'slots-rest': {
      // The dual rest stage. `rest` below reads the single-slot view, which
      // stays null for a bilateral run: each slot carries its own sets.
      const states = waitFor.slots.map((slot) => {
        const entry = snapshot.devices?.find((d) => d.slotId === slot);
        return [slot, entry?.sets?.active ?? null, (entry?.sets?.completed ?? []).length];
      });
      return {
        ok: states.every(([, active, logged]) => active === null && logged > 0),
        detail: states
          .map(([slot, active, logged]) => `${slot}=${active ? 'open' : 'none'}/${logged}`)
          .join(' '),
      };
    }
    case 'rest': {
      const logged = (snapshot.sets?.completed ?? []).length;
      return {
        ok: snapshot.session !== null && !snapshot.sets?.active && logged > 0,
        detail: `session=${snapshot.session ? 'open' : 'none'} activeSet=${
          snapshot.sets?.active ? 'open' : 'none'
        } logged=${logged}`,
      };
    }
    case 'sessions-ended': {
      const { sessions } = await getJson(port, '/api/history');
      return {
        ok: snapshot.session === null && sessions.length >= waitFor.minSessions,
        detail: `session=${snapshot.session ? 'open' : 'none'} history=${sessions.length}`,
      };
    }
    case 'plan-seeded': {
      const tree = await getJson(port, '/api/plan-tree');
      const planned = (tree.program?.blocks ?? [])
        .flatMap((b) => b.weeks ?? [])
        .flatMap((w) => w.templates ?? [])
        .flatMap((t) => t.exercises ?? []);
      return {
        ok: planned.length >= waitFor.minExercises,
        detail: `plannedExercises=${planned.length}`,
      };
    }
    default:
      throw new Error(`unsupported waitFor kind: ${JSON.stringify(waitFor)}`);
  }
}

/** Poll `evaluateWait` until it holds, or throw naming the last state observed. */
async function waitForState(port, waitFor, label) {
  const deadline = Date.now() + PREDICATE_TIMEOUT_MS;
  let detail = 'never sampled';
  while (Date.now() < deadline) {
    const result = await evaluateWait(port, waitFor);
    if (result.ok) return result.detail;
    detail = result.detail;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: predicate ${waitFor.kind} never held (last state: ${detail})`);
}

// ── the page ───────────────────────────────────────────────────────────────

/**
 * The page's rendered text with every whitespace run collapsed to one space.
 * The dashboard puts a label and its value in separate blocks, so `LBS` and the
 * number under it are two `innerText` lines; flattening is what lets a shot
 * assert the PAIR ("TONNAGE 0 lbs") rather than a bare number that would match
 * anywhere on the page.
 */
async function pageText(page) {
  const raw = await page.evaluate(() => document.body.innerText);
  return raw.replace(/\s+/g, ' ').trim();
}

/** Every expected string that is NOT in the page's rendered text right now. */
function missingIn(text, expected) {
  return expected.filter((want) => !text.includes(want));
}

/**
 * What the page says where an expected string should have been. Locating the
 * longest matching prefix and printing what follows turns "missing TONNAGE 0
 * lbs" into "…got TONNAGE 12 lbs", which names the field AND its wrong value.
 */
function nearMiss(text, want) {
  for (let end = want.length - 1; end > 0; end--) {
    const at = text.indexOf(want.slice(0, end));
    if (at >= 0) return `"${want}" but page has "${text.slice(at, at + want.length + 16)}…"`;
  }
  return `"${want}" (no part of it is on the page)`;
}

/**
 * Wait until the page has rendered every expected string, or throw naming the
 * gaps. The report is built from the CLOSEST sample seen, not the last one: a
 * driver keeps moving while this waits, so the final sample can be a page from
 * the next set entirely, and "wrong value" would be reported as "wrong screen".
 */
async function waitForText(page, expected, label) {
  const deadline = Date.now() + TEXT_TIMEOUT_MS;
  let closest = { text: '', missing: expected };
  while (Date.now() < deadline) {
    const text = await pageText(page);
    const missing = missingIn(text, expected);
    if (missing.length === 0) return;
    if (missing.length <= closest.missing.length) closest = { text, missing };
    await sleep(POLL_MS);
  }
  const report = closest.missing.map((want) => nearMiss(closest.text, want));
  throw new Error(`${label}: page never rendered ${report.join('; ')}`);
}

/**
 * Block until the bundled webfonts have loaded and the browser has produced two
 * frames. Signals, not a sleep: a shot taken before `document.fonts.ready`
 * captures fallback metrics and reflows a moment later.
 */
async function settlePaint(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** Width and height straight out of the PNG's IHDR — no image library needed. */
function pngDimensions(file) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Take one shot: open the route, wait for the state, wait for the page to show
 * it, screenshot, then re-assert. The re-assert is what turns "the browser wrote
 * a file" into "the file shows the thing" — a blank or half-mounted render
 * throws nothing.
 *
 * `holdsPageOpen` decides which side of the predicate the route is opened on,
 * and the definition explains why each shot picks the side it does.
 */
async function captureShot(page, origin, port, shot, outDir) {
  const target = `${origin}${shot.route}`;
  const open = async () => {
    if (page.url() === target) await page.reload({ waitUntil: 'networkidle' });
    else await page.goto(target, { waitUntil: 'networkidle' });
  };

  const expected = [...shot.expectText, ...shot.expectValues];
  if (shot.holdsPageOpen && page.url() !== target) await open();
  const observed = await waitForState(port, shot.waitFor, shot.name);
  if (!shot.holdsPageOpen) await open();
  await waitForText(page, expected, shot.name);
  await settlePaint(page);

  const file = path.join(outDir, `${shot.name}.png`);
  await page.screenshot({ path: file, fullPage: false });

  const after = await pageText(page);
  const stillMissing = missingIn(after, expected);
  if (stillMissing.length > 0) {
    const report = stillMissing.map((want) => nearMiss(after, want));
    throw new Error(`${shot.name}: state moved during the capture, lost ${report.join('; ')}`);
  }

  const bytes = fs.statSync(file).size;
  const { width, height } = pngDimensions(file);
  log(`${shot.name}: ${width}x${height}, ${Math.round(bytes / 1024)} kB (${observed})`);
  return {
    name: shot.name,
    scenario: shot.scenario,
    route: shot.route,
    caption: shot.caption,
    file: `${shot.name}.png`,
    waitFor: shot.waitFor,
    assertedText: shot.expectText,
    assertedValues: shot.expectValues,
    width,
    height,
    bytes,
    // Informational: reruns differ (the page paints a wall clock and a count-up
    // rest timer), so nothing gates on this. It is here to make "did this shot
    // actually change" answerable from the diff.
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

// ── clips: narration ───────────────────────────────────────────────────────
//
// The script in the repo is the SOURCE of the audio, never a transcript of it.
// Synthesis needs a python with `kokoro-onnx` installed, named by
// `VMCP_NARRATION_PYTHON` (docs/screenshot-harness.md). When that is set the
// audio is re-synthesised every run, so editing a script and re-running changes
// what is spoken. When it is NOT set the committed audio is reused — but only if
// its recorded hash still matches the script, so an edit without the prerequisite
// is a loud failure rather than a clip that silently says the old thing.

/** The python used to synthesise, or null when the prerequisite is not installed here. */
const NARRATION_PYTHON = process.env.VMCP_NARRATION_PYTHON ?? null;

/** Run a command to completion, throwing with its stderr rather than a bare exit code. */
function exec(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${(result.stderr ?? '').slice(-1500)}`);
  }
  return result.stdout ?? '';
}

/** A media file's duration in seconds, straight out of ffprobe. */
function durationSeconds(file) {
  const out = exec('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`);
  return seconds;
}

/**
 * Synthesise `text` to a committed AAC track. Kokoro is byte-deterministic for a
 * fixed voice and text — two runs of the same script produce identical wavs — so
 * the audio half of a clip is reproducible in the strict sense the video half
 * cannot be.
 */
function synthesizeNarration(text, audioFile, voice, kbps, tmpDir) {
  const wav = path.join(tmpDir, `${path.basename(audioFile, '.m4a')}.wav`);
  exec('npx', ['--yes', 'hyperframes', 'tts', text, '-o', wav, '-v', voice, '--json'], {
    HYPERFRAMES_PYTHON: NARRATION_PYTHON,
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  });
  exec('ffmpeg', ['-y', '-i', wav, '-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', '1', audioFile]);
}

/**
 * The narration track for one clip: re-synthesised when the prerequisite is
 * present, otherwise the committed file, checked against the script's hash.
 */
function narrationFor(clip, clipsDir, previous, cfg, tmpDir) {
  const scriptPath = path.join(REPO_ROOT, cfg.narrationDir, clip.narrationFile);
  if (!fs.existsSync(scriptPath)) throw new Error(`${clip.name}: no narration at ${scriptPath}`);
  const text = cfg.narrationText(fs.readFileSync(scriptPath, 'utf8'));
  const hash = cfg.narrationHash(text);
  const audio = path.join(clipsDir, `${clip.name}.narration.m4a`);

  if (NARRATION_PYTHON) {
    synthesizeNarration(text, audio, cfg.voice, cfg.audioKbps, tmpDir);
  } else if (!fs.existsSync(audio) || previous?.narrationHash !== hash) {
    throw new Error(
      `${clip.name}: ${clip.narrationFile} has no matching audio and VMCP_NARRATION_PYTHON is ` +
        `unset — see docs/screenshot-harness.md for the synthesis prerequisite`,
    );
  }
  return { audio, hash, seconds: durationSeconds(audio), regenerated: NARRATION_PYTHON !== null };
}

// ── clips: recording ───────────────────────────────────────────────────────

/**
 * Four samples per SPA poll: often enough that no stage the page rendered is
 * missed, slow enough that reading the DOM does not compete with the screencast
 * encoder for the same process and cost the clip frames.
 */
const CLIP_SAMPLE_MS = 500;

/**
 * A blank 1280x800 frame compresses to a few kB; a rendered dashboard frame is
 * two orders of magnitude larger. This is a floor against an empty render, not a
 * content check — the text assertions are what prove the content.
 */
const FRAME_MIN_BYTES = 20_000;

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Watch the page's text as the camera runs. A still asserts against one moment;
 * a clip has to assert against the WHOLE run, because the stage that proves it is
 * not blank may be thirty seconds from the stage that proves it reached rest.
 */
function makeWatch(expected) {
  const pending = new Set(expected);
  let closest = { text: '', missing: expected.length + 1 };
  return {
    observe(text) {
      for (const want of [...pending]) if (text.includes(want)) pending.delete(want);
      const missing = missingIn(text, expected).length;
      if (missing <= closest.missing) closest = { text, missing };
    },
    assert(label) {
      if (pending.size === 0) return;
      const report = [...pending].map((want) => nearMiss(closest.text, want));
      throw new Error(`${label}: never rendered ${report.join('; ')} while the camera ran`);
    },
  };
}

/** Sample the page until `waitFor` holds, or throw naming the last state observed. */
async function collectUntil(page, port, waitFor, label, watch) {
  const deadline = Date.now() + PREDICATE_TIMEOUT_MS;
  let detail = 'never sampled';
  while (Date.now() < deadline) {
    watch.observe(await pageText(page));
    const result = await evaluateWait(port, waitFor);
    if (result.ok) return result.detail;
    detail = result.detail;
    await sleep(CLIP_SAMPLE_MS);
  }
  throw new Error(`${label}: ${waitFor.kind} never held while recording (last state: ${detail})`);
}

/** Keep sampling for a fixed window — the lead-out, after the end predicate has already fired. */
async function collectFor(page, ms, watch) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    watch.observe(await pageText(page));
    await sleep(CLIP_SAMPLE_MS);
  }
}

/**
 * Record one clip. The page is opened only once the START predicate holds, so
 * the camera never rolls on a blank dashboard, and it closes once the END
 * predicate has held for the lead-out — a pad after a predicate, not a sleep
 * standing in for one.
 */
async function recordClip(browser, clip, port, rawDir, cfg) {
  const startedOn = await waitForState(port, clip.startWhen, clip.name);
  const context = await browser.newContext({
    viewport: { ...cfg.viewport },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    recordVideo: { dir: rawDir, size: { ...cfg.size } },
  });
  const page = await context.newPage();
  const watch = makeWatch([...clip.expectText, ...clip.expectValues]);
  // `domcontentloaded`, NOT `networkidle`: the live page holds `/api/stream`
  // (SSE) open for as long as it is mounted, so there is no idle moment to wait
  // for and `networkidle` times out after 30s. Nothing is lost — the fonts and
  // first paint are waited on below, and the clip's own predicate and text watch
  // are what decide when there is something worth recording.
  await page.goto(`http://127.0.0.1:${port}${clip.route}`, { waitUntil: 'domcontentloaded' });
  await settlePaint(page);

  const endedOn = await collectUntil(page, port, clip.endWhen, clip.name, watch);
  await collectFor(page, cfg.leadOutMs, watch);
  const video = page.video();
  await context.close();
  watch.assert(clip.name);
  return { raw: await video.path(), startedOn, endedOn };
}

// ── clips: encoding and proof ──────────────────────────────────────────────

/**
 * Mux the silent screencast and the narration into the published clip. The audio
 * is stream-copied, so what ships inside the video is byte-identical to the
 * committed narration track; it is also SHORTER than the video, deliberately, and
 * an mp4 whose audio track ends early is ordinary. Padding it to length instead
 * would force a re-encode and turn an overrun narration into a truncated word
 * rather than the hard error {@link NARRATION_HEADROOM_MS} makes it.
 */
function muxClip(rawVideo, audio, outFile, cfg) {
  exec('ffmpeg', [
    ...['-y', '-i', rawVideo, '-i', audio],
    ...['-map', '0:v:0', '-map', '1:a:0'],
    ...['-c:v', 'libx264', '-crf', String(cfg.crf), '-preset', 'slow'],
    ...['-pix_fmt', 'yuv420p', '-r', String(cfg.fps)],
    ...['-c:a', 'copy', '-movflags', '+faststart'],
    outFile,
  ]);
}

/**
 * Decode three frames spread across the clip and hash them. This is the proof a
 * still gets from its own file size and cannot be had from a video's: a clip that
 * recorded a blank stage, or that froze on frame one, encodes and plays back
 * without error. Distinct, substantial frames are what rules both out.
 */
function sampleFrames(file, seconds, tmpDir) {
  const frames = [0.15, 0.5, 0.85].map((fraction, index) => {
    const at = (seconds * fraction).toFixed(2);
    const png = path.join(tmpDir, `${path.basename(file, '.mp4')}-${index}.png`);
    exec('ffmpeg', ['-y', '-ss', at, '-i', file, '-frames:v', '1', png]);
    const bytes = fs.statSync(png).size;
    if (bytes < FRAME_MIN_BYTES) {
      throw new Error(`${file}: frame at ${at}s is ${bytes} B — the clip looks blank`);
    }
    return { atSeconds: Number(at), bytes, sha256: sha256File(png) };
  });
  if (new Set(frames.map((f) => f.sha256)).size !== frames.length) {
    throw new Error(`${file}: sampled frames are identical — the clip is frozen`);
  }
  return frames;
}

/**
 * Take one clip end to end: record, check the narration fits, mux, prove the
 * frames, and return the manifest entry.
 */
async function captureClip(browser, clip, port, clipsDir, cfg, tmpDir, previous) {
  const narration = narrationFor(clip, clipsDir, previous, cfg, tmpDir);
  const { raw, startedOn, endedOn } = await recordClip(browser, clip, port, tmpDir, cfg);
  const videoSeconds = durationSeconds(raw);
  if (narration.seconds + cfg.headroomMs / 1000 > videoSeconds) {
    throw new Error(
      `${clip.name}: narration is ${narration.seconds.toFixed(1)}s but the clip is only ` +
        `${videoSeconds.toFixed(1)}s — shorten ${clip.narrationFile} or lengthen the clip`,
    );
  }

  const file = path.join(clipsDir, `${clip.name}.mp4`);
  muxClip(raw, narration.audio, file, cfg);
  const bytes = fs.statSync(file).size;
  if (bytes > cfg.maxBytes) {
    throw new Error(`${clip.name}: ${Math.round(bytes / 1024)} kB exceeds the committed ceiling`);
  }
  const seconds = durationSeconds(file);
  log(
    `${clip.name}: ${seconds.toFixed(1)}s, ${Math.round(bytes / 1024)} kB, ` +
      `narration ${narration.seconds.toFixed(1)}s (${startedOn} -> ${endedOn})`,
  );
  return {
    name: clip.name,
    scenario: clip.scenario,
    route: clip.route,
    caption: clip.caption,
    file: `clips/${clip.name}.mp4`,
    narrationFile: clip.narrationFile,
    narrationAudio: `clips/${clip.name}.narration.m4a`,
    narrationHash: narration.hash,
    narrationSeconds: Number(narration.seconds.toFixed(3)),
    narrationRegenerated: narration.regenerated,
    startWhen: clip.startWhen,
    endWhen: clip.endWhen,
    assertedText: clip.expectText,
    assertedValues: clip.expectValues,
    width: cfg.size.width,
    height: cfg.size.height,
    fps: cfg.fps,
    seconds: Number(seconds.toFixed(3)),
    bytes,
    // Informational, like a shot's `sha256`: a live clock and a non-deterministic
    // encoder mean reruns differ, so nothing gates on these. They are here so
    // "did this clip actually change, and is it still moving" is answerable.
    frames: sampleFrames(file, seconds, tmpDir),
    sha256: sha256File(file),
  };
}

// ── scenarios ──────────────────────────────────────────────────────────────

/** Minimal MCP handshake: the dashboard sidecar only binds once a client activates. */
function handshake(child) {
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capture-screens', version: '0.1.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Start a scenario and return `{ child, port, stop }`. `driver: null` boots the
 * server directly and holds the empty state indefinitely; a driver is spawned
 * detached so stopping it signals the whole group, including the MCP server it
 * owns as a grandchild.
 */
async function startScenario(scenario, dbDir) {
  const port = await probeFreePort();
  const controlPort = await probeFreePort();
  // One store per scenario: never shared, never `~/.voltras/vmcp.sqlite`.
  const dbPath = path.join(dbDir, `${scenario.name}.sqlite`);
  const substitute = (arg) =>
    arg.replace('{port}', String(port)).replace('{controlPort}', String(controlPort));
  const env = {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(port),
    VMCP_DB_PATH: dbPath,
  };

  const child = scenario.driver
    ? spawn(process.execPath, [scenario.driver, ...scenario.args.map(substitute)], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    : spawn(process.execPath, [BIN_PATH], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });

  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
    });
  }
  if (!scenario.driver) handshake(child);

  const deadline = Date.now() + DASHBOARD_BIND_TIMEOUT_MS;
  for (;;) {
    try {
      await getJson(port, '/api/snapshot');
      break;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `${scenario.name}: dashboard never bound on :${port} (${err.message})\n${tail}`,
        );
      }
      await sleep(POLL_MS);
    }
  }
  log(`${scenario.name}: dashboard on :${port}`);

  const stop = () => {
    try {
      if (scenario.driver) process.kill(-child.pid, 'SIGINT');
      else child.stdin.end();
    } catch {
      // already gone
    }
    child.kill('SIGKILL');
  };
  return { port, stop, tail: () => tail };
}

// ── main ───────────────────────────────────────────────────────────────────

/** Every stills scenario that owns at least one wanted shot, captured in definition order. */
async function captureShots(browser, shots, defs, dbDir, outDir) {
  if (shots.length === 0) return [];
  const page = await browser.newPage({
    viewport: { ...defs.CAPTURE_VIEWPORT },
    deviceScaleFactor: defs.CAPTURE_DEVICE_SCALE_FACTOR,
    // Fixed so the wall clock the live page renders is at least in a known
    // zone across machines. It still differs run to run — see the manifest note.
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const captured = [];
  for (const scenario of defs.CAPTURE_SCENARIOS) {
    const wanted = shots.filter((s) => s.scenario === scenario.name);
    if (wanted.length === 0) continue;
    const scene = await startScenario(scenario, dbDir);
    try {
      const origin = `http://127.0.0.1:${scene.port}`;
      for (const shot of wanted) {
        captured.push(await captureShot(page, origin, scene.port, shot, outDir));
      }
    } catch (err) {
      throw new Error(`${scenario.name}: ${err.message}\n--- driver output ---\n${scene.tail()}`);
    } finally {
      scene.stop();
    }
  }
  await page.close();
  return captured;
}

/** The same shape for clips: one scenario run per clip group, one recording context per clip. */
async function captureClips(browser, clips, cfg, dbDir, clipsDir, tmpDir, previous) {
  if (clips.length === 0) return [];
  fs.mkdirSync(clipsDir, { recursive: true });
  const byName = new Map(previous.map((entry) => [entry.name, entry]));
  const captured = [];
  for (const scenario of cfg.scenarios) {
    const wanted = clips.filter((c) => c.scenario === scenario.name);
    if (wanted.length === 0) continue;
    const scene = await startScenario(scenario, dbDir);
    try {
      for (const clip of wanted) {
        const was = byName.get(clip.name);
        captured.push(await captureClip(browser, clip, scene.port, clipsDir, cfg, tmpDir, was));
      }
    } catch (err) {
      throw new Error(`${scenario.name}: ${err.message}\n--- driver output ---\n${scene.tail()}`);
    } finally {
      scene.stop();
    }
  }
  return captured;
}

/** Merge freshly captured entries over the previous ones, then sort into definition order. */
function mergeEntries(previous, captured, definition) {
  const merged = new Map(previous.map((entry) => [entry.name, entry]));
  for (const entry of captured) merged.set(entry.name, entry);
  const order = new Map(definition.map((entry, index) => [entry.name, index]));
  return [...merged.values()]
    .filter((entry) => order.has(entry.name))
    .sort((a, b) => order.get(a.name) - order.get(b.name));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const [label, file] of [
    ['npm run build', BIN_PATH],
    ['npm run build', DEFINITION],
    ['npm run build', CLIP_DEFINITION],
    ['npm run build:dashboard', SPA_INDEX],
  ]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing — run \`${label}\` first`);
  }

  const defs = await import(DEFINITION);
  const clipDefs = await import(CLIP_DEFINITION);
  const { CAPTURE_MANIFEST, CAPTURE_SHOTS } = defs;
  const { CAPTURE_CLIPS } = clipDefs;

  const shots = narrow(CAPTURE_SHOTS, args.only, args.record, '--only');
  const clips = narrow(CAPTURE_CLIPS, args.record, args.only, '--record');

  const outDir = path.join(REPO_ROOT, defs.CAPTURE_DIR);
  const clipsDir = path.join(REPO_ROOT, clipDefs.CLIP_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-captures-'));
  if (dbDir.includes('.voltras')) throw new Error('refusing to run against the real store');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-clips-'));

  const manifestPath = path.join(REPO_ROOT, CAPTURE_MANIFEST);
  const before = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};

  const cfg = {
    viewport: defs.CAPTURE_VIEWPORT,
    size: clipDefs.CLIP_SIZE,
    fps: clipDefs.CLIP_FPS,
    crf: clipDefs.CLIP_VIDEO_CRF,
    audioKbps: clipDefs.CLIP_AUDIO_BITRATE_KBPS,
    leadOutMs: clipDefs.CLIP_LEAD_OUT_MS,
    headroomMs: clipDefs.NARRATION_HEADROOM_MS,
    maxBytes: clipDefs.CLIP_MAX_BYTES,
    voice: clipDefs.NARRATION_VOICE,
    narrationDir: clipDefs.NARRATION_DIR,
    narrationText: clipDefs.narrationText,
    narrationHash: clipDefs.narrationHash,
    scenarios: clipDefs.CLIP_SCENARIOS,
  };

  const browser = await chromium.launch({ headless: true });
  let captured = [];
  let recorded = [];
  try {
    captured = await captureShots(browser, shots, defs, dbDir, outDir);
    recorded = await captureClips(browser, clips, cfg, dbDir, clipsDir, tmpDir, before.clips ?? []);
  } finally {
    await browser.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        // No wall-clock field anywhere in here: a rerun that changes nothing
        // should produce no manifest diff beyond the image hashes themselves.
        // A narrowed run keeps every entry it did not re-take, so one shot or
        // one clip can be refreshed without invalidating the rest.
        definitionHash: defs.captureDefinitionHash(),
        viewport: defs.CAPTURE_VIEWPORT,
        deviceScaleFactor: defs.CAPTURE_DEVICE_SCALE_FACTOR,
        shots: mergeEntries(before.shots ?? [], captured, CAPTURE_SHOTS),
        clipDefinitionHash: clipDefs.clipDefinitionHash(),
        clipSize: clipDefs.CLIP_SIZE,
        clipFps: clipDefs.CLIP_FPS,
        clips: mergeEntries(before.clips ?? [], recorded, CAPTURE_CLIPS),
      },
      null,
      2,
    ) + '\n',
  );
  log(`wrote ${captured.length} shot(s), ${recorded.length} clip(s) and ${CAPTURE_MANIFEST}`);
}

main().catch((err) => {
  console.error('[capture] FAIL:', err.message);
  process.exit(1);
});
