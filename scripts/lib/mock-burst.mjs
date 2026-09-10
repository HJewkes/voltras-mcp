// Deterministic rep bursts from the mock adapter, for drivers that need the
// values on screen to be predictable (`npm run docs:captures`).
//
// ── The problem ────────────────────────────────────────────────────────────
// `MockBLEAdapter` free-runs. It streams a rep cycle continuously from the
// moment `device.connect` returns, so a driver that opens a set, sleeps N
// seconds and closes it cuts the stream at two arbitrary points: the set gets a
// partial rep at the front, a whole-number-plus-a-bit at the back, and a rep
// count that drifts with event-loop jitter. Every derived value downstream —
// peak velocity, velocity loss, the fatigue verdict, tonnage — moves with it.
// Two consecutive capture runs disagreed on the fatigue readout (5.5 "Good" vs
// 6.0 "Slowing") for exactly this reason.
//
// ── The lever ──────────────────────────────────────────────────────────────
// The adapter's own set boundary is the one place its generator comes to a
// clean stop. After `repsPerSet` reps it emits a set boundary, zeroes
// `repInSet`, and enters `resting` — and while resting it returns BEFORE
// touching `phaseIndex` / `sampleInPhase`, so the generator is parked exactly at
// the start of a rep cycle for the whole rest. Park it for an hour and the
// device holds that state indefinitely, emitting idle frames.
//
// So: park the device between sets, and release it for exactly one burst of
// `reps` reps per set. Every frame in a burst is then a pure function of
// (phase index, sample index, rep index) — the adapter's fatigue term reads
// `repInSet`, which the rest reset to 0 — so every burst emits a byte-identical
// frame sequence, run after run.
//
// The real pipeline is untouched: these are real frames from the real mock
// adapter, decoded by the real SDK, segmented by the real analytics. What is
// pinned is WHEN the device moves, not what the dashboard is told.
//
// ── What is still not deterministic ────────────────────────────────────────
// Frame TIMESTAMPS (`Date.now()` at decode) and therefore everything derived
// from elapsed time: set duration, tempo seconds, rest countdowns. So is the
// number of idle frames on either side of a burst, which is why a capture
// asserts nothing about durations — see `expectValues` in
// `src/docs/capture-shots.ts`.

/**
 * Rest long enough to be indefinite for a capture run. The device parks here
 * after every burst and only leaves when {@link releaseBurst} says so.
 */
export const PARK_MS = 3_600_000;

/**
 * Ticks to allow the parked device to notice a shortened rest. The adapter
 * re-reads `restBetweenSetsMs` once per 91 ms sample tick; three ticks is a
 * wide margin, and overshooting costs nothing because a burst that has already
 * started ignores the restored value.
 */
const RELEASE_GRACE_MS = 300;

/** POST one route on the two-slot preload's loopback control server. */
export async function control(controlPort, route, body) {
  const res = await fetch(`http://127.0.0.1:${controlPort}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${route} ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * The connect-time profile fragment for a pinned device: one rep on connect,
 * then park. The single rep is unavoidable — the adapter starts streaming from
 * `connect` and only its own set boundary can stop it — so it is made as small
 * and as early as possible, before any session is open.
 */
export function pinnedConnectProfile() {
  return { repsPerSet: 1, restBetweenSetsMs: PARK_MS };
}

/** Arm a parked device for bursts of exactly `reps` reps. */
export async function armBursts(controlPort, deviceId, reps) {
  await control(controlPort, '/configure', {
    deviceId,
    config: { repsPerSet: reps, restBetweenSetsMs: PARK_MS },
  });
}

/**
 * Let a parked device run one burst. Shortens the rest so the next tick ends
 * it, then restores the park so the device stops again after the burst.
 */
export async function releaseBurst(controlPort, deviceId, reps) {
  await control(controlPort, '/configure', { deviceId, config: { restBetweenSetsMs: 1 } });
  await new Promise((resolve) => setTimeout(resolve, RELEASE_GRACE_MS));
  await control(controlPort, '/configure', {
    deviceId,
    config: { repsPerSet: reps, restBetweenSetsMs: PARK_MS },
  });
}

/**
 * Seconds a burst of `reps` reps takes to stream, plus the connect-time rep.
 * The weight-training profile is 32 samples per rep at 91 ms — used only to
 * size waits, never to time an assertion.
 */
export function burstDurationMs(reps) {
  return reps * 32 * 91;
}
