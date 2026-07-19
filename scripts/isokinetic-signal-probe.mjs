#!/usr/bin/env node
// isokinetic-signal-probe: bench harness to VET FORCE-AT-VELOCITY SIGNAL QUALITY.
//
// SPIKE / THROWAWAY. This is a proof-of-concept for the discovery-warmup
// north-star's "isokinetic probe" question: when the device holds velocity
// constant and lets force float, is the force telemetry clean enough to seed a
// strength estimate from? This script does NOT answer that — it CAPTURES the
// signal at the bench so a human can judge it. Not an MCP tool, not for merge.
//
// ── What it does ────────────────────────────────────────────────────────────
//   1. Connects to one Voltra via the SDK (VoltraManager), same adapter
//      selection the server uses (mock | node-noble).
//   2. Puts the device into isokinetic mode and sets a CONSERVATIVE target
//      speed (device holds this velocity; the eccentric speed limit is the
//      return-stroke fail-safe). Uses the SDK's isokinetic setters — no raw
//      protocol.
//   3. Taps the per-sample telemetry stream (`client.onFrame`, ~11 Hz) during a
//      short push effort and records (t, force, velocity, position, phase) —
//      exactly the pattern the isometric `captureTrial` uses
//      (src/tools/isometric-tools.ts:299).
//   4. Emits a force-at-velocity summary: is velocity actually pinned to the
//      commanded speed? how stable is force while it is pinned? peak & plateau
//      force, observed sample rate, latency to reach commanded speed, dropouts.
//   5. Optional multi-speed SWEEP (2-3 target speeds) so you can see the SHAPE
//      of the force-velocity relationship — a single point can't project to a
//      load, a sweep hints at the curve.
//
// ── How to run it (at the bench, real hardware) ─────────────────────────────
//   npm ci && npm run build          # build not required — this is plain .mjs
//   # macOS: the terminal must hold Bluetooth permission (node-noble backend).
//
//   # Single conservative point (0.5 m/s), 6 s effort, auto-picks first device:
//   VOLTRA_ADAPTER=node node scripts/isokinetic-signal-probe.mjs
//
//   # Target a named device and sweep three speeds:
//   VOLTRA_ADAPTER=node DEVICE=VTR-1234 SWEEP=400,550,700 \
//     node scripts/isokinetic-signal-probe.mjs
//
//   # Dry-run the plumbing with the in-process mock (NO real force — see below):
//   VOLTRA_ADAPTER=mock node scripts/isokinetic-signal-probe.mjs
//
//   Env knobs: DEVICE (name substring), SPEED (mm/s, single), SWEEP (csv mm/s),
//   EFFORT_MS (per-effort capture window, default 6000), REST_MS (between
//   speeds, default 8000), ECC_LIMIT (return-stroke speed cap mm/s, default
//   600), ENGAGE (1=engage motor so it actively holds velocity, default 1),
//   COUNTDOWN_MS (get-ready beat before each effort, default 3000).
//
// ── Bench protocol (what to actually DO while it runs) ──────────────────────
//   For each speed the script announces a countdown, then "PUSH NOW". During
//   the capture window, do ONE smooth all-out concentric push against the cable
//   and let it return under control. The device caps velocity, so you cannot
//   accelerate the cable past the commanded speed — push as hard as you like;
//   the force you generate at that pinned speed is the reading we want.
//
// ── Reading the output: good signal vs bad signal ───────────────────────────
//   GOOD:  observed rate ~10-11 Hz with no gap > ~200 ms; during the push,
//          velocity sits within tolerance of the commanded speed (velocity is
//          "pinned"); force rises, holds a recognizable plateau, and the
//          plateau CV is low (say < ~10%); a clear latency-to-speed you can read
//          (motor reaches commanded speed within a few hundred ms of push
//          onset); slower commanded speeds show HIGHER plateau force than faster
//          ones (a real F-V slope). => isokinetic is a viable probe.
//   BAD:   velocity never pins (motor doesn't hold the set speed, or overshoots
//          wildly); force is spiky with no plateau / high CV; frequent dropouts
//          or a rate far below ~10 Hz; plateau force does not order sensibly
//          with speed across the sweep. => isokinetic signal is not clean enough
//          to seed from; prefer the isometric probe.
//
// ── Mock caveat ─────────────────────────────────────────────────────────────
//   Under VOLTRA_ADAPTER=mock the in-process adapter streams synthetic frames
//   (~100 lb, its own kinematics) the moment you connect; it does NOT model the
//   isokinetic velocity clamp or real user force. Mock is ONLY good for proving
//   the capture/teardown plumbing runs end-to-end. Every force/velocity number
//   under mock is fictional — the header on the report says so.
//
// ── Safety ──────────────────────────────────────────────────────────────────
//   Starts at a conservative commanded speed; sets the eccentric speed limit as
//   the return-stroke fail-safe; engages for only the short effort window;
//   ALWAYS stops recording, unloads the cable, and unsubscribes the frame tap
//   in a `finally`, even on error / Ctrl-C. Isokinetic is speed-capped, so an
//   all-out push cannot runaway-accelerate the cable.

import { VoltraManager, TrainingMode } from '@voltras/node-sdk';

// ── Fitness-unit conversions (semantic layer only; no protocol here) ─────────
// The telemetry stream reports force in tenths of a pound and velocity in mm/s
// (same as the server's event-bridge, which divides force by this and passes
// velocity through mmsToMps). We convert once, at the tap, so every number this
// script prints is already in fitness units (lbs, m/s).
const FORCE_TENTHS_PER_LB = 10;
const MM_PER_M = 1000;
const toLbs = (rawForce) => Math.abs(rawForce) / FORCE_TENTHS_PER_LB;
const toMps = (rawVelocity) => Math.abs(rawVelocity) / MM_PER_M;

// Semantic phase labels — the stream carries a numeric movement-phase index
// (1=concentric, 2=hold, 3=eccentric, else idle). Matches live-signal.mapPhase.
const phaseLabel = (code) =>
  code === 1 ? 'con' : code === 2 ? 'hold' : code === 3 ? 'ecc' : 'idle';

const num = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  adapter: process.env.VOLTRA_ADAPTER === 'mock' ? 'mock' : 'node',
  device: process.env.DEVICE ?? '',
  speeds: parseSpeeds(),
  effortMs: num('EFFORT_MS', 6000),
  restMs: num('REST_MS', 8000),
  eccLimitMmPerSec: num('ECC_LIMIT', 600),
  engage: process.env.ENGAGE !== '0',
  countdownMs: num('COUNTDOWN_MS', 3000),
  // How close velocity must sit to the commanded speed to count as "pinned",
  // as a fraction of the commanded speed. The core signal-quality question.
  pinTolerance: num('PIN_TOL', 0.15),
};

// SWEEP (csv mm/s) wins over SPEED (single mm/s); default one conservative point.
function parseSpeeds() {
  if (process.env.SWEEP) {
    return process.env.SWEEP.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return [num('SPEED', 500)];
}

async function main() {
  const manager =
    CONFIG.adapter === 'mock' ? VoltraManager.forMock() : VoltraManager.forNodeNoble();
  let client;
  try {
    client = await connect(manager);
    const available = safeAvailableSpeeds(client);
    const summaries = [];
    for (let i = 0; i < CONFIG.speeds.length; i++) {
      const commanded = snap(CONFIG.speeds[i], available);
      const samples = await captureAtSpeed(client, commanded);
      const summary = analyze(samples, commanded);
      summaries.push(summary);
      printSpeedSummary(summary);
      if (i < CONFIG.speeds.length - 1) {
        log(`resting ${CONFIG.restMs} ms before next speed…`);
        await sleep(CONFIG.restMs);
      }
    }
    printReport(summaries);
  } finally {
    // Belt-and-braces teardown: unload + disconnect + dispose regardless of how
    // we got here. Per-effort teardown already stopped recording + unloaded.
    if (client) {
      await safe(() => client.stopRecording());
      await safe(() => client.unloadDevice());
      await safe(() => client.disconnect());
    }
    manager.dispose();
  }
}

async function connect(manager) {
  log(`scanning (${CONFIG.adapter})…`);
  const client = CONFIG.device
    ? await manager.connectByName(CONFIG.device)
    : await manager.connectFirst();
  log(`connected${CONFIG.device ? ` to "${CONFIG.device}"` : ''}.`);
  return client;
}

function safeAvailableSpeeds(client) {
  try {
    const list = client.getAvailableIsokineticTargetSpeeds?.() ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Snap a requested speed to the nearest device-supported value so we command a
// value the firmware accepts verbatim (and print it if we moved).
function snap(requested, available) {
  if (available.length === 0) return requested;
  const nearest = available.reduce((a, b) =>
    Math.abs(b - requested) < Math.abs(a - requested) ? b : a,
  );
  if (nearest !== requested) {
    log(`snapped requested ${requested} mm/s → supported ${nearest} mm/s`);
  }
  return nearest;
}

// Configure isokinetic, engage, capture one effort window, then tear the effort
// down (stop recording + unload) so the cable is safe during rest.
async function captureAtSpeed(client, commanded) {
  await client.setMode(TrainingMode.Isokinetic);
  await client.setIsokineticTargetSpeed(commanded);
  await client.setIsokineticEccMode('isokinetic');
  await client.setIsokineticEccSpeedLimit(CONFIG.eccLimitMmPerSec); // return fail-safe
  log(`\n== commanded speed ${commanded} mm/s (${(commanded / MM_PER_M).toFixed(2)} m/s) ==`);
  if (CONFIG.engage) await client.startRecording(); // motor actively holds velocity
  try {
    await countdown();
    log('PUSH NOW — one smooth all-out concentric, controlled return.');
    return await captureEffort(client, CONFIG.effortMs);
  } finally {
    await safe(() => client.stopRecording());
    await safe(() => client.unloadDevice());
  }
}

// The heart of the probe — mirrors isometric captureTrial: subscribe to onFrame,
// buffer one fitness-unit sample per frame, always unsubscribe in `finally`.
function captureEffort(client, durationMs) {
  return new Promise((resolve) => {
    const samples = [];
    const startMs = Date.now();
    const unsubscribe = client.onFrame((frame) => {
      samples.push({
        tMs: Date.now() - startMs,
        forceLbs: toLbs(frame.force),
        velocityMps: toMps(frame.velocity),
        position: frame.position,
        phase: phaseLabel(frame.phase),
      });
    });
    setTimeout(() => {
      if (typeof unsubscribe === 'function') unsubscribe();
      resolve(samples);
    }, durationMs);
  });
}

async function countdown() {
  const steps = Math.max(0, Math.round(CONFIG.countdownMs / 1000));
  for (let s = steps; s > 0; s--) {
    log(`get ready… ${s}`);
    await sleep(1000);
  }
}

// ── Signal-quality analysis ──────────────────────────────────────────────────
function analyze(samples, commandedMmPerSec) {
  const commandedMps = commandedMmPerSec / MM_PER_M;
  const rate = observedRate(samples);
  const dropouts = findDropouts(samples, rate.medianGapMs);
  // "Pinned" = velocity within tolerance of commanded speed AND actually moving
  // concentrically (the push). This is the window the force reading is valid in.
  const tol = CONFIG.pinTolerance * commandedMps;
  const pinned = samples.filter(
    (s) => s.phase === 'con' && Math.abs(s.velocityMps - commandedMps) <= tol,
  );
  const pinnedForces = pinned.map((s) => s.forceLbs);
  return {
    commandedMmPerSec,
    commandedMps,
    sampleCount: samples.length,
    ...rate,
    dropoutCount: dropouts.length,
    maxGapMs: dropouts.reduce((m, g) => Math.max(m, g.gapMs), rate.medianGapMs),
    pinnedFraction: samples.length ? pinned.length / samples.length : 0,
    velocityAll: stats(samples.map((s) => s.velocityMps)),
    velocityPinnedError: stats(pinned.map((s) => Math.abs(s.velocityMps - commandedMps))),
    peakForceLbs: samples.reduce((m, s) => Math.max(m, s.forceLbs), 0),
    pinnedForce: stats(pinnedForces),
    plateauForce: plateau(pinnedForces),
    latencyToSpeedMs: latencyToSpeed(samples, commandedMps, tol),
    noiseFloorLbs: noiseFloor(samples),
  };
}

function observedRate(samples) {
  if (samples.length < 2) return { observedHz: 0, medianGapMs: 0 };
  const gaps = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i].tMs - samples[i - 1].tMs);
  const span = samples[samples.length - 1].tMs - samples[0].tMs;
  return {
    observedHz: span > 0 ? Number(((samples.length - 1) / (span / 1000)).toFixed(2)) : 0,
    medianGapMs: median(gaps),
  };
}

// Gaps materially larger than the median cadence = a stall/dropout in the stream.
function findDropouts(samples, medianGapMs) {
  if (medianGapMs <= 0) return [];
  const threshold = Math.max(medianGapMs * 2.5, medianGapMs + 60);
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const gapMs = samples[i].tMs - samples[i - 1].tMs;
    if (gapMs > threshold) out.push({ atMs: samples[i].tMs, gapMs });
  }
  return out;
}

// Time from the first moving-concentric frame until velocity first reaches
// within tolerance of the commanded speed — how fast the motor pins the speed.
function latencyToSpeed(samples, commandedMps, tol) {
  const onset = samples.find((s) => s.phase === 'con' && s.velocityMps > 0.02);
  if (!onset) return null;
  const reached = samples.find(
    (s) => s.tMs >= onset.tMs && Math.abs(s.velocityMps - commandedMps) <= tol,
  );
  return reached ? reached.tMs - onset.tMs : null;
}

// Noise floor: force spread during the quietest stretch (idle / near-still),
// i.e. what the cell reads when the user is NOT pushing.
function noiseFloor(samples) {
  const quiet = samples.filter((s) => s.velocityMps < 0.02 && s.phase !== 'con');
  return stats(quiet.map((s) => s.forceLbs));
}

// Plateau = mean of the sustained top band (>= 90% of peak) of the pinned-force
// series — the "held" force we would seed from, not the transient spike.
function plateau(forces) {
  if (forces.length === 0) return null;
  const peak = Math.max(...forces);
  const band = forces.filter((f) => f >= 0.9 * peak);
  return band.length ? Number(mean(band).toFixed(1)) : null;
}

// ── small stats helpers ──────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stats(xs) {
  if (xs.length === 0) return { n: 0, mean: null, sd: null, cvPct: null, min: null, max: null };
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  return {
    n: xs.length,
    mean: Number(m.toFixed(2)),
    sd: Number(sd.toFixed(2)),
    cvPct: m !== 0 ? Number(((sd / m) * 100).toFixed(1)) : null,
    min: Number(Math.min(...xs).toFixed(2)),
    max: Number(Math.max(...xs).toFixed(2)),
  };
}

// ── reporting ────────────────────────────────────────────────────────────────
function printSpeedSummary(s) {
  log(`  samples: ${s.sampleCount} @ ~${s.observedHz} Hz (median gap ${s.medianGapMs} ms)`);
  log(`  dropouts: ${s.dropoutCount} (max gap ${Math.round(s.maxGapMs)} ms)`);
  log(
    `  velocity pinned: ${(s.pinnedFraction * 100).toFixed(0)}% of frames within ` +
      `±${(CONFIG.pinTolerance * 100).toFixed(0)}% of ${s.commandedMps.toFixed(2)} m/s`,
  );
  log(`  pinned-velocity error: mean ${fmt(s.velocityPinnedError.mean)} m/s`);
  log(
    `  latency to commanded speed: ${s.latencyToSpeedMs == null ? 'n/a' : s.latencyToSpeedMs + ' ms'}`,
  );
  log(
    `  force @ pinned velocity: mean ${fmt(s.pinnedForce.mean)} lb, ` +
      `plateau ${fmt(s.plateauForce)} lb, CV ${fmt(s.pinnedForce.cvPct)}% (n=${s.pinnedForce.n})`,
  );
  log(`  peak force (whole window): ${fmt(s.peakForceLbs)} lb`);
  log(
    `  noise floor (not pushing): mean ${fmt(s.noiseFloorLbs.mean)} lb, ` +
      `sd ${fmt(s.noiseFloorLbs.sd)} lb (n=${s.noiseFloorLbs.n})`,
  );
}

function printReport(summaries) {
  log('\n================ FORCE-AT-VELOCITY SUMMARY ================');
  if (CONFIG.adapter === 'mock') {
    log('!! MOCK ADAPTER — all force/velocity below is SYNTHETIC, not a real');
    log('!! isokinetic reading. Use this run only to confirm the plumbing works.');
  }
  log('speed(m/s)  pinned%  force_mean  plateau  forceCV%  latency(ms)  rate(Hz)  dropouts');
  for (const s of summaries) {
    log(
      [
        s.commandedMps.toFixed(2).padStart(9),
        (s.pinnedFraction * 100).toFixed(0).padStart(8),
        fmt(s.pinnedForce.mean).padStart(11),
        fmt(s.plateauForce).padStart(8),
        fmt(s.pinnedForce.cvPct).padStart(9),
        String(s.latencyToSpeedMs ?? 'n/a').padStart(12),
        String(s.observedHz).padStart(9),
        String(s.dropoutCount).padStart(9),
      ].join(''),
    );
  }
  if (summaries.length >= 2) {
    log('\nF-V shape check: plateau force should DECREASE as speed increases.');
    const ordered = [...summaries].sort((a, b) => a.commandedMps - b.commandedMps);
    const monotonic = ordered.every(
      (s, i) => i === 0 || (s.plateauForce ?? 0) <= (ordered[i - 1].plateauForce ?? Infinity),
    );
    log(
      monotonic
        ? '  -> plateau force ordered sensibly with speed (encouraging).'
        : '  -> plateau force did NOT order with speed — suspect noisy signal or effort.',
    );
  }
  log("\nJudge signal quality against the rubric in this script's header comment.");
  log('==========================================================');
}

const fmt = (v) => (v == null ? 'n/a' : String(v));
const log = (msg) => process.stdout.write(msg + '\n');
async function safe(fn) {
  try {
    await fn();
  } catch (err) {
    log(`  (teardown step failed, continuing: ${err?.message ?? err})`);
  }
}

// Clean stop on Ctrl-C: main()'s finally handles teardown, but a bare SIGINT
// would skip it — so translate it into a rejection the finally can run through.
process.on('SIGINT', () => {
  log('\nSIGINT — tearing down…');
  process.exitCode = 130;
});

main().catch((err) => {
  log(`\nFATAL: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
