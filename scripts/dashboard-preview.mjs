#!/usr/bin/env node
// dashboard-preview: browse a real wall dashboard page in a browser, with no
// Voltra, no PT session and no risk to the real store (VW-416).
//
// The wall dashboard is a sidecar of a running MCP server, so until now looking
// at `#/goals` meant owning a device and starting a workout — the pages existed
// only inside a session. This boots one mock-adapter server on a scratch store,
// seeds it, prints the URL and then just holds it open.
//
// Usage:
//   npm run build && npm run build:dashboard
//   npm run dashboard:preview -- goals
//   npm run dashboard:preview -- goals --state behind
//   npm run dashboard:preview -- body
//   npm run dashboard:preview -- plan
//
// ── What it is NOT ─────────────────────────────────────────────────────────
// `npm run dashboard:sim` (scripts/dashboard-sim.mjs) is the neighbouring
// command and could not do this: it mutates a fake `DashboardServerState` with a
// stub store that answers `listSessions: () => []`, so there is no history, no
// plan tree and no goal data behind any of the non-live pages. It renders the
// LIVE page from fabricated reps; every page this command exists for would come
// back empty. So this reuses the capture harness's scenarios and launcher
// instead (`src/docs/capture-shots.ts`, `scripts/lib/dashboard-launch.mjs`),
// which boot the real `dist/bin.js` over a real store.
//
// ── `--state` ──────────────────────────────────────────────────────────────
// `#/goals` takes `--state calibrating|on_track|behind|ahead|hit_exact|
// beyond_goal`, which seeds the readings that land the goal read model in that
// state. The definitions, and why a driven run can only ever produce
// `calibrating`, are in `src/docs/preview-seeds.ts`; the statuses they reach are
// pinned by `src/dashboard/__tests__/preview-seeds.test.ts`.
//
// ── Isolation ──────────────────────────────────────────────────────────────
// Each run gets its own scratch directory holding its own `VMCP_DB_PATH`,
// removed on exit. `~/.voltras/vmcp.sqlite` is never opened, and refusing a
// scratch path that looks like it is the last line of defence.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJson, scenarioDbPath, startScenario } from './lib/dashboard-launch.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');
const SPA_INDEX = path.join(REPO_ROOT, 'dist/spa/index.html');
const SEEDS = path.join(REPO_ROOT, 'dist/docs/preview-seeds.js');
const SHOTS = path.join(REPO_ROOT, 'dist/docs/capture-shots.js');

const log = (...args) => console.error('[preview]', ...args);

/** `<page> [--state <name>]`, also accepting `--state=<name>`. */
function parseArgs(argv, pages) {
  const args = { page: null, state: 'on_track' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--state') args.state = argv[++i];
    else if (arg.startsWith('--state=')) args.state = arg.slice('--state='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else if (args.page === null) args.page = arg;
    else throw new Error(`unexpected second page: ${arg}`);
  }
  if (args.page === null) {
    throw new Error(`name a page: ${pages.map((page) => page.name).join(', ')}`);
  }
  return args;
}

function pageNamed(pages, name) {
  const found = pages.find((page) => page.name === name);
  if (found === undefined) {
    throw new Error(`unknown page ${name}; known: ${pages.map((p) => p.name).join(', ')}`);
  }
  return found;
}

/** A scratch directory of our own, which is never anywhere near the real store. */
function makeScratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-preview-'));
  if (dir.includes('.voltras')) throw new Error('refusing to run against the real store');
  return dir;
}

/**
 * The goals scenario: seed the store, then boot the plain server over it. The
 * seed runs to completion and CLOSES before the server opens the same file —
 * one process per `VMCP_DB_PATH`, always.
 */
async function seedGoals(dbDir, stateName) {
  const { SqliteSessionStore } = await import(path.join(REPO_ROOT, 'dist/store/sqlite-store.js'));
  const { goalPreviewState, seedGoalPreview } = await import(SEEDS);
  const state = goalPreviewState(stateName);
  const store = SqliteSessionStore.open(scenarioDbPath(dbDir, 'goals'));
  try {
    const report = await seedGoalPreview(store, state, new Date());
    log(
      `seeded --state ${state.name}: ${report.sets} sets across ${report.sessions} session(s), ` +
        `top ${report.latestLoadLbs} lb, baseline ${report.baselineState}`,
    );
    log(`  ${state.summary}`);
  } finally {
    store.close();
  }
  return { name: 'goals', driver: null, args: [] };
}

/** Every other page reuses the capture scenario that already drives it. */
async function captureScenarioFor(page) {
  const { CAPTURE_SCENARIOS } = await import(SHOTS);
  const found = CAPTURE_SCENARIOS.find((scenario) => scenario.name === page.captureScenario);
  if (found === undefined) throw new Error(`no capture scenario named ${page.captureScenario}`);
  return found;
}

/** What the goal read model actually landed on, read back off the running server. */
async function reportGoalStatus(port) {
  const { priorities } = await getJson(port, '/api/goals');
  const rollup = priorities[0]?.rollup;
  if (rollup === undefined || rollup === null) {
    log('WARNING: the seeded priority has no rollup — the page will read as empty');
    return;
  }
  log(`goal read model: status ${rollup.status}`);
}

async function main() {
  for (const [label, file] of [
    ['npm run build', BIN_PATH],
    ['npm run build', SEEDS],
    ['npm run build:dashboard', SPA_INDEX],
  ]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing — run \`${label}\` first`);
  }
  const { PREVIEW_PAGES } = await import(SEEDS);
  const args = parseArgs(process.argv.slice(2), PREVIEW_PAGES);
  const page = pageNamed(PREVIEW_PAGES, args.page);

  const dbDir = makeScratchDir();
  const cleanUp = () => fs.rmSync(dbDir, { recursive: true, force: true });
  let scene = null;
  try {
    const scenario =
      page.captureScenario === null
        ? await seedGoals(dbDir, args.state)
        : await captureScenarioFor(page);
    scene = await startScenario(scenario, dbDir, {
      log,
      clientName: 'dashboard-preview',
      echo: scenario.driver !== null,
    });
    if (page.captureScenario === null) await reportGoalStatus(scene.port);
  } catch (err) {
    scene?.stop();
    cleanUp();
    throw err;
  }

  // The port is probed free at boot, so it is never the same twice: print the
  // URL rather than remembering one.
  console.log(`\n  ${page.summary}\n  http://127.0.0.1:${scene.port}${page.route}\n`);
  log('holding the server open — Ctrl-C to stop and remove the scratch store.');

  const stop = () => {
    scene.stop();
    cleanUp();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // An explicit handle, rather than relying on the child's pipes to hold the
  // loop open: a driver that exits on its own would otherwise take this process
  // — and the server it is holding open — down with it.
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('[preview] FAIL:', err.message);
  process.exit(1);
});
