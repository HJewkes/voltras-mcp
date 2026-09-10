#!/usr/bin/env node
// Produce the docs site's dashboard screenshots, headlessly, from a committed
// definition (`src/docs/capture-shots.ts`).
//
// Usage:
//   npm run build && npm run build:dashboard
//   npm run docs:captures                       # every shot
//   npm run docs:captures -- --only live-rest   # re-take one
//
// ── How a shot is timed ────────────────────────────────────────────────────
// The mock drivers are TIME-driven and cannot be stepped, so every shot waits on
// a PREDICATE over `/api/snapshot` (the same JSON the SPA polls) rather than on a
// sleep. This is not a style preference: a dashboard that failed to mount, lost
// its stylesheet or rendered an empty stage screenshots perfectly cleanly and
// throws nothing, so a fixed delay would write a blank PNG and report success.
// After the predicate fires the script also WAITS for the shot's expected strings
// to be in the DOM, screenshots, then re-reads the DOM and fails if any of them
// has gone — the capture is bracketed by the assertion, not followed by it.
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

import { spawn } from 'node:child_process';
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

/** How often the predicate re-reads `/api/snapshot`. Well under the SPA's own 2s poll. */
const POLL_MS = 250;
/**
 * Per-shot ceiling. The longest predicate (`sessions-ended`) waits out a whole
 * planned run — three exercises of two 12s sets with 10s rests, ~2 minutes — so
 * this is generous on purpose and only ever fires on a genuinely stuck run.
 */
const PREDICATE_TIMEOUT_MS = 300_000;
/** How long the dashboard sidecar gets to bind after the driver starts. */
const DASHBOARD_BIND_TIMEOUT_MS = 60_000;

const log = (...args) => console.error('[capture]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
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
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!res.ok) throw new Error(`${route} -> ${res.status}`);
  return res.json();
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
      const counts = waitFor.slots.map((slot) => [slot, slotReps(snapshot, slot)]);
      return {
        ok: counts.every(([, reps]) => reps !== null && reps >= waitFor.minReps),
        detail: counts.map(([slot, reps]) => `${slot}=${reps ?? '—'}`).join(' '),
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

/** Every expected string that is NOT in the page's rendered text right now. */
async function missingText(page, expectText) {
  const text = await page.evaluate(() => document.body.innerText);
  return expectText.filter((expected) => !text.includes(expected));
}

/** Wait until the page has rendered every expected string, or throw listing the gaps. */
async function waitForText(page, expectText, label) {
  const deadline = Date.now() + PREDICATE_TIMEOUT_MS;
  let missing = expectText;
  while (Date.now() < deadline) {
    missing = await missingText(page, expectText);
    if (missing.length === 0) return;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: page never rendered ${JSON.stringify(missing)}`);
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

  if (shot.holdsPageOpen && page.url() !== target) await open();
  const observed = await waitForState(port, shot.waitFor, shot.name);
  if (!shot.holdsPageOpen) await open();
  await waitForText(page, shot.expectText, shot.name);
  await settlePaint(page);

  const file = path.join(outDir, `${shot.name}.png`);
  await page.screenshot({ path: file, fullPage: false });

  const stillMissing = await missingText(page, shot.expectText);
  if (stillMissing.length > 0) {
    throw new Error(
      `${shot.name}: state moved during the capture, lost ${JSON.stringify(stillMissing)}`,
    );
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
    width,
    height,
    bytes,
    // Informational: reruns differ (the page paints a wall clock and a count-up
    // rest timer), so nothing gates on this. It is here to make "did this shot
    // actually change" answerable from the diff.
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const [label, file] of [
    ['npm run build', BIN_PATH],
    ['npm run build', DEFINITION],
    ['npm run build:dashboard', SPA_INDEX],
  ]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing — run \`${label}\` first`);
  }

  const {
    CAPTURE_DIR,
    CAPTURE_MANIFEST,
    CAPTURE_SCENARIOS,
    CAPTURE_SHOTS,
    CAPTURE_VIEWPORT,
    CAPTURE_DEVICE_SCALE_FACTOR,
    captureDefinitionHash,
  } = await import(DEFINITION);

  const shots = args.only ? CAPTURE_SHOTS.filter((s) => s.name === args.only) : CAPTURE_SHOTS;
  if (shots.length === 0) {
    throw new Error(
      `--only ${args.only} matches no shot; known: ${CAPTURE_SHOTS.map((s) => s.name).join(', ')}`,
    );
  }

  const outDir = path.join(REPO_ROOT, CAPTURE_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-captures-'));
  if (dbDir.includes('.voltras')) throw new Error('refusing to run against the real store');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { ...CAPTURE_VIEWPORT },
    deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
    // Fixed so the wall clock the live page renders is at least in a known
    // zone across machines. It still differs run to run — see the manifest note.
    timezoneId: 'UTC',
    locale: 'en-US',
  });

  const captured = [];
  try {
    for (const scenario of CAPTURE_SCENARIOS) {
      const wanted = shots.filter((s) => s.scenario === scenario.name);
      if (wanted.length === 0) continue;
      const run = await startScenario(scenario, dbDir);
      try {
        const origin = `http://127.0.0.1:${run.port}`;
        for (const shot of wanted) {
          captured.push(await captureShot(page, origin, run.port, shot, outDir));
        }
      } catch (err) {
        throw new Error(`${scenario.name}: ${err.message}\n--- driver output ---\n${run.tail()}`);
      } finally {
        run.stop();
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }

  // A `--only` run keeps the entries it did not re-take, so one shot can be
  // refreshed without invalidating the rest of the manifest.
  const manifestPath = path.join(REPO_ROOT, CAPTURE_MANIFEST);
  const previous = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).shots ?? [])
    : [];
  const merged = new Map(previous.map((entry) => [entry.name, entry]));
  for (const entry of captured) merged.set(entry.name, entry);
  const order = new Map(CAPTURE_SHOTS.map((shot, index) => [shot.name, index]));

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        // No wall-clock field anywhere in here: a rerun that changes nothing
        // should produce no manifest diff beyond the image hashes themselves.
        definitionHash: captureDefinitionHash(),
        viewport: CAPTURE_VIEWPORT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
        shots: [...merged.values()]
          .filter((entry) => order.has(entry.name))
          .sort((a, b) => order.get(a.name) - order.get(b.name)),
      },
      null,
      2,
    ) + '\n',
  );
  log(`wrote ${captured.length} shot(s) and ${CAPTURE_MANIFEST}`);
}

main().catch((err) => {
  console.error('[capture] FAIL:', err.message);
  process.exit(1);
});
