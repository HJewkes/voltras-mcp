// replay-preload: make `VOLTRA_ADAPTER=mock` replay a flight-recorder
// capture instead of synthesizing telemetry.
//
// Loaded into the MCP server process with `node --import <this file>
// dist/bin.js` by `scripts/dashboard-replay-drive.mjs`. Nothing in `src/`
// changes; this file only swaps what `VoltraManager.forMock()` hands back —
// the same technique `scripts/mock-two-slot-preload.mjs` uses to reshape the
// mock adapter, applied here to substitute an entirely different one.
//
// `VMCP_REPLAY_CAPTURE` (required) names a capture file in the recorder's
// `{ type: 'frame_in', ts, hex }` JSONL schema (`src/state/session-recorder.ts`,
// `VMCP_RECORD_SESSION=1`). It is read with the SDK's own public
// `loadCaptureFrames` (`@voltras/node-sdk/testing`) — this file never touches
// a protocol byte itself. Frames feed a `ReplayBLEAdapter` with
// `autoStart: false`: playback starts only once the driver calls `/play` on
// the control server below, so no frame lands before an MCP set is open to
// receive it (a set opened by `set.start`, not by connecting the device).
//
// Env:
//   VMCP_REPLAY_CAPTURE      path to the capture JSONL (required)
//   VMCP_REPLAY_SPEED        playback speed multiplier (default 1 = real-time)
//   VMCP_REPLAY_CONTROL_PORT loopback control-server port (default 7736; 0 disables)

import http from 'node:http';
import { readFileSync } from 'node:fs';

import { VoltraManager } from '@voltras/node-sdk';
import { ReplayBLEAdapter, loadCaptureFrames } from '@voltras/node-sdk/testing';

const CAPTURE_PATH = process.env.VMCP_REPLAY_CAPTURE;
if (!CAPTURE_PATH) {
  throw new Error('replay-preload: VMCP_REPLAY_CAPTURE is required (path to a capture JSONL file)');
}
const PLAYBACK_SPEED = Number(process.env.VMCP_REPLAY_SPEED ?? 1);
const CONTROL_PORT = Number(process.env.VMCP_REPLAY_CONTROL_PORT ?? 7736);

const jsonl = readFileSync(CAPTURE_PATH, 'utf8');
let skipCount = 0;
const frames = loadCaptureFrames(jsonl, {
  onSkip: (skip) => {
    skipCount += 1;
    process.stderr.write(`[replay-preload] skipped line ${skip.line} (${skip.reason})\n`);
  },
});
if (frames.length === 0) {
  throw new Error(`replay-preload: ${CAPTURE_PATH} decoded to zero telemetry frames`);
}
process.stderr.write(
  `[replay-preload] loaded ${frames.length} frame(s) from ${CAPTURE_PATH}` +
    (skipCount > 0 ? ` (${skipCount} line(s) skipped)` : '') +
    ` — speed ${PLAYBACK_SPEED}x\n`,
);

/** The most recently created adapter — single-slot, so there is ever only one live at a time. */
let currentAdapter;

VoltraManager.forMock = () =>
  new VoltraManager({
    platform: 'mock',
    adapterFactory: () => {
      currentAdapter = new ReplayBLEAdapter({
        frames,
        playbackSpeed: PLAYBACK_SPEED,
        autoStart: false,
      });
      return currentAdapter;
    },
  });

// ── control server ─────────────────────────────────────────────────────────

function startControlServer() {
  const server = http.createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && req.url === '/play') {
      if (!currentAdapter) return send(409, { error: 'no replay adapter connected yet' });
      currentAdapter.play();
      return send(200, { ok: true, playing: currentAdapter.isPlaying() });
    }
    if (req.method === 'GET' && req.url === '/status') {
      if (!currentAdapter) return send(200, { connected: false });
      return send(200, {
        connected: true,
        playing: currentAdapter.isPlaying(),
        currentFrameIndex: currentAdapter.currentFrameIndex(),
        totalFrames: currentAdapter.totalFrames(),
      });
    }
    send(404, { error: `no route ${req.method} ${req.url}` });
  });
  // Loopback only, and unref'd so it never keeps the MCP server alive by itself.
  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    process.stderr.write(`[replay-preload] control server on 127.0.0.1:${CONTROL_PORT}\n`);
  });
  server.unref();
}

if (CONTROL_PORT > 0) startControlServer();
