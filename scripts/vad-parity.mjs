#!/usr/bin/env node
// VMCP-02.77 P1 de-risk artifact (manual, NOT CI).
//
// Loads the bundled Silero VAD v4 model and runs it over a 16 kHz mono 16-bit
// WAV, per 512-sample frame, printing max/mean speech probability and the count
// of frames above 0.5. A speech clip should yield many high-prob frames; pure
// silence yields ~0. Reimplements the tiny run-loop inline (rather than
// importing src/voice/vad.ts, which is TS) so this stays a plain runnable .mjs.
//
// Usage: node scripts/vad-parity.mjs [path/to/16k-mono.wav]

/* global console, process */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-node';

const FRAME = 512;
const STATE_LEN = 2 * 1 * 64;
const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(HERE, '..', 'voice-models', 'silero_vad.onnx');
const DEFAULT_WAV =
  '/private/tmp/claude-501/-Users-hjewkes-Library-Application-Support-active-work-voltras-workspace/5fa6d4c9-1b98-4632-bb13-86634e1183a9/scratchpad/mictest.wav';

function loadPcm(wavPath) {
  const buf = readFileSync(wavPath);
  // Strip the standard 44-byte RIFF/WAVE header; interpret the rest as int16 LE.
  const body = buf.subarray(44);
  const usable = body.byteLength - (body.byteLength % 2);
  return new Int16Array(body.buffer, body.byteOffset, usable / 2);
}

async function main() {
  const wavArg = process.argv[2];
  const wavPath = wavArg ? resolve(wavArg) : DEFAULT_WAV;
  if (!existsSync(wavPath)) {
    console.log(`SKIP: no WAV at ${wavPath} (pass one as argv[1])`);
    return;
  }
  const pcm = loadPcm(wavPath);
  const session = await ort.InferenceSession.create(MODEL_PATH);

  let h = new Float32Array(STATE_LEN);
  let c = new Float32Array(STATE_LEN);
  const probs = [];
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    const audio = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) audio[i] = pcm[off + i] / 32768;
    const feeds = {
      input: new ort.Tensor('float32', audio, [1, FRAME]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
      h: new ort.Tensor('float32', h, [2, 1, 64]),
      c: new ort.Tensor('float32', c, [2, 1, 64]),
    };
    const out = await session.run(feeds);
    h = out.hn.data;
    c = out.cn.data;
    probs.push(out.output.data[0]);
  }

  report(wavPath, probs);
}

function report(wavPath, probs) {
  if (probs.length === 0) {
    console.log(`FAIL: WAV ${wavPath} produced 0 frames`);
    return;
  }
  const max = Math.max(...probs);
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const above = probs.filter((p) => p > 0.5).length;
  console.log(`WAV:    ${wavPath}`);
  console.log(`frames: ${probs.length}  above-0.5: ${above}`);
  console.log(`max:    ${max.toFixed(4)}  mean: ${mean.toFixed(4)}`);
  const verdict = max > 0.5 ? `PASS: speech detected: max=${max.toFixed(2)}` : 'FAIL: no speech';
  console.log(verdict);
}

main().catch((err) => {
  console.error('vad-parity error:', err);
  process.exitCode = 1;
});
