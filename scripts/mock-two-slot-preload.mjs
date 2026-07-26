// mock-two-slot-preload: make `VOLTRA_ADAPTER=mock` advertise TWO Voltras.
//
// Loaded into the MCP server process with `node --import <this file> dist/bin.js`
// by `scripts/dashboard-mock-drive.mjs --dual`. Nothing in `src/` changes; this
// file only reshapes what the SDK's mock adapter pretends to be.
//
// Why it is needed ──────────────────────────────────────────────────────────
// `MockBLEAdapter.scan()` returns exactly ONE synthetic device
// (`mock-voltra-001` / `VTR-Mock`), and `VoltraManager.connect()` short-circuits
// to the already-connected client when asked for a deviceId it holds. So a
// stock mock run can never populate a second slot: `device.connect(slot:'right')`
// would either fail (`DEVICE_NOT_FOUND`) or hand `right` the SAME client object
// as `left`, producing one telemetry stream mirrored into two slots — no rep
// isolation, therefore nothing a dual-Voltra view can actually be tested against.
//
// What this patches (and what it deliberately does NOT) ─────────────────────
//   * `VoltraManager.forMock()` — rebuilt with an adapterFactory that decorates
//     each `MockBLEAdapter` instance. The manager, LegacyAdapterHost, VoltraClient,
//     event bridge, LiveState, MCP tools and dashboard are all untouched and run
//     exactly as in a single-device mock session. The host already allocates a
//     FRESH adapter per dial, so each slot ends up with its own independent
//     telemetry generator — the rep isolation is real, not simulated.
//   * `adapter.scan()` — returns the configured device list instead of one entry.
//     Names keep the `VTR-` prefix or `filterVoltraDevices` would drop them.
//   * `adapter.connect(deviceId)` — stamps that device's identity/config onto the
//     adapter that dialled it, and registers it in a control registry.
//
// Runtime control plane ─────────────────────────────────────────────────────
// The adapters live inside the server process, out of reach of the driver's
// JSON-RPC channel (`mock.configure` is NOT_IMPLEMENTED at the tool layer). So
// this preload also opens a tiny loopback HTTP control server:
//
//   GET  /devices                          → [{ deviceId, connected, stalled }]
//   POST /configure  { deviceId, config }  → adapter.configure(config)
//   POST /stall      { deviceId }          → freeze telemetry (drop 100% of frames)
//   POST /resume     { deviceId }          → clear injected errors
//
// A stall is modelled as `injectError('notificationDrop', { dropRate: 1 })`: the
// BLE link stays up and the slot stays "connected", but no frames arrive, so
// that side's rep stream simply stops advancing while the other keeps going.
// That is the case a dual view has to render as an aligned empty column rather
// than a missing one.
//
// Env:
//   VMCP_MOCK_DEVICES        JSON array of device profiles (see DEFAULT_DEVICES)
//   VMCP_MOCK_CONTROL_PORT   control-server port (default 7735; 0 disables)

import http from 'node:http';

import { MockBLEAdapter, VoltraManager } from '@voltras/node-sdk';

/**
 * Per-device mock profile. `weight` / `repsPerSet` / `restBetweenSetsMs` are
 * passed to `adapter.configure()` at connect time, so the two sides can differ
 * in cadence and load without any shared state.
 */
const DEFAULT_DEVICES = [
  { deviceId: 'mock-voltra-left', deviceName: 'VTR-MockL', weight: 100, repsPerSet: 5 },
  { deviceId: 'mock-voltra-right', deviceName: 'VTR-MockR', weight: 100, repsPerSet: 5 },
];

function readDevices() {
  const raw = process.env.VMCP_MOCK_DEVICES;
  if (!raw) return DEFAULT_DEVICES;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('VMCP_MOCK_DEVICES must be a non-empty JSON array');
  }
  for (const d of parsed) {
    if (typeof d.deviceId !== 'string') throw new Error('each device needs a deviceId');
    if (typeof d.deviceName !== 'string' || !d.deviceName.startsWith('VTR-')) {
      throw new Error(`deviceName must start with "VTR-" (got ${String(d.deviceName)})`);
    }
  }
  return parsed;
}

const DEVICES = readDevices();
const CONTROL_PORT = Number(process.env.VMCP_MOCK_CONTROL_PORT ?? 7735);

/** deviceId → live adapter, populated as each slot dials. */
const adapters = new Map();
/** deviceId → whether a stall is currently injected (control-plane bookkeeping). */
const stalled = new Map();

function profileFor(deviceId) {
  return DEVICES.find((d) => d.deviceId === deviceId);
}

/** Instance-level decoration — no prototype mutation, so unrelated SDK users are unaffected. */
function decorate(adapter) {
  adapter.scan = async () =>
    DEVICES.map((d) => ({ id: d.deviceId, name: d.deviceName, rssi: -50 }));

  const connect = adapter.connect.bind(adapter);
  adapter.connect = async (deviceId, options) => {
    const profile = profileFor(deviceId);
    if (profile) {
      const { deviceId: id, deviceName, ...runtime } = profile;
      adapter.configure({ deviceId: id, deviceName, ...runtime });
    }
    await connect(deviceId, options);
    adapters.set(deviceId, adapter);
    stalled.set(deviceId, false);
  };

  const disconnect = adapter.disconnect.bind(adapter);
  adapter.disconnect = async () => {
    await disconnect();
    for (const [id, a] of adapters) if (a === adapter) adapters.delete(id);
  };

  return adapter;
}

VoltraManager.forMock = (config) =>
  new VoltraManager({
    platform: 'mock',
    adapterFactory: () => decorate(new MockBLEAdapter(config)),
  });

// ── control server ─────────────────────────────────────────────────────────

function resolveAdapter(body) {
  const adapter = adapters.get(body?.deviceId);
  if (!adapter) throw new Error(`no connected mock adapter for deviceId ${String(body?.deviceId)}`);
  return adapter;
}

const ROUTES = {
  '/configure': (body) => {
    resolveAdapter(body).configure(body.config ?? {});
    return { ok: true };
  },
  '/stall': (body) => {
    resolveAdapter(body).injectError('notificationDrop', { dropRate: 1 });
    stalled.set(body.deviceId, true);
    return { ok: true, stalled: true };
  },
  '/resume': (body) => {
    resolveAdapter(body).clearErrors();
    stalled.set(body.deviceId, false);
    return { ok: true, stalled: false };
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function startControlServer() {
  const server = http.createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/devices') {
      send(
        200,
        DEVICES.map((d) => ({
          deviceId: d.deviceId,
          connected: adapters.has(d.deviceId),
          stalled: stalled.get(d.deviceId) ?? false,
        })),
      );
      return;
    }
    const route = ROUTES[req.url ?? ''];
    if (req.method !== 'POST' || !route) {
      send(404, { error: `no route ${req.method} ${req.url}` });
      return;
    }
    readBody(req)
      .then((body) => send(200, route(body)))
      .catch((err) => send(400, { error: err.message }));
  });
  // Loopback only, and unref'd so it never keeps the MCP server alive by itself.
  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    process.stderr.write(`[mock-preload] control server on 127.0.0.1:${CONTROL_PORT}\n`);
  });
  server.unref();
}

if (CONTROL_PORT > 0) startControlServer();
process.stderr.write(
  `[mock-preload] mock scan will advertise: ${DEVICES.map((d) => d.deviceId).join(', ')}\n`,
);
