// A SYNTHETIC flight-recorder capture, generated fresh on every call — never a
// transcription of a real one. Real captures hold raw device frames and stay
// private (see `src/state/session-recorder.ts`); this fixture exists so the
// replay driver's plumbing (VW-256) can be tested without one.
//
// Frames are built through the SDK's own public domain-level API
// (`createFrame`, `MovementPhase`) and encoded with its own public
// `encodeTelemetryFrame` — this file never constructs or names a protocol
// byte itself. The JSONL lines match the exact `{ type: 'frame_in', ts, hex }`
// shape `session-recorder.ts` writes and `loadCaptureFrames` reads.

import { createFrame, encodeTelemetryFrame, MovementPhase } from '@voltras/node-sdk';

/** Wall-clock spacing between samples, matching the SDK's documented ~11 Hz cadence. */
const SAMPLE_STEP_MS = 90;
/** Cable extension (mm) reached at the top of each synthesized rep. */
const PEAK_POSITION_MM = 500;
/** Samples per phase half (concentric or eccentric) of one synthesized rep. */
const SAMPLES_PER_PHASE = 4;

function frameLine(sequence: number, phase: MovementPhase, position: number, ts: number): string {
  const velocity = phase === MovementPhase.CONCENTRIC ? 400 : -350;
  const frame = createFrame(sequence, phase, position, 200, velocity);
  const hex = Buffer.from(encodeTelemetryFrame(frame)).toString('hex');
  return JSON.stringify({ type: 'frame_in', ts, hex });
}

/**
 * Build a synthetic capture JSONL string carrying `repCount` clean
 * concentric->eccentric cycles — enough for the analytics rep-segmentation
 * (`addSampleToSet`) to detect `repCount` completed reps end to end.
 */
export function buildSyntheticReplayCapture(repCount: number): string {
  const lines = [
    JSON.stringify({
      type: 'capture_meta',
      schema: 1,
      startedAt: new Date(0).toISOString(),
    }),
  ];
  let sequence = 0;
  let ts = 0;
  for (let rep = 0; rep < repCount; rep += 1) {
    for (let i = 0; i < SAMPLES_PER_PHASE; i += 1) {
      const position = Math.round((PEAK_POSITION_MM * (i + 1)) / SAMPLES_PER_PHASE);
      lines.push(frameLine(sequence, MovementPhase.CONCENTRIC, position, ts));
      sequence += 1;
      ts += SAMPLE_STEP_MS;
    }
    for (let i = 0; i < SAMPLES_PER_PHASE; i += 1) {
      const position = Math.round(PEAK_POSITION_MM * (1 - (i + 1) / SAMPLES_PER_PHASE));
      lines.push(frameLine(sequence, MovementPhase.ECCENTRIC, position, ts));
      sequence += 1;
      ts += SAMPLE_STEP_MS;
    }
  }
  return `${lines.join('\n')}\n`;
}
