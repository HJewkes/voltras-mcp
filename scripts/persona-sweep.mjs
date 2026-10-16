#!/usr/bin/env node
// persona-sweep: every dashboard page and every read path, over every synthetic
// lifter, at wall and phone sizes in lb and kg (VW-945).
//
// Usage:
//   npm run build && npm run build:dashboard
//   npm run sweep
//   npm run sweep -- --persona steady,plateau
//
// Writes `sweep-out/<run>/` (gitignored): one PNG per page, `findings.json` and
// an `index.html` contact sheet. The checks themselves are in
// `scripts/lib/sweep-checks.mjs`; `docs/screenshot-harness.md` says how to read
// a run. Not a CI gate: a finding is something to file, not a failed build, so
// the command exits 0 unless the harness itself broke.
//
// ── The clock ──────────────────────────────────────────────────────────────
// A persona's history ends the Sunday before the week its seed clock falls in,
// so a page viewed at that clock shows an empty current week, and Body's
// this-week view would never show plateau's over-recovery biceps. So every
// persona is seeded at a Monday 05:00 and VIEWED at the Sunday 23:30 before it:
// the last history week is "this week", all of it already trained. `messy` is
// the exception and is viewed at its seed clock: its open session is seven hours
// stale there, which is what makes the server's boot-time idle close fire.
// Both instants are fixed calendar dates, so two runs render the same pages and
// "changed since last run" means the code changed.
//
// ── Isolation ──────────────────────────────────────────────────────────────
// Every persona is seeded into a new file under the run directory; the real
// store is never opened, and the debug tools stay gated off.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { scenarioDbPath, startScenario } from './lib/dashboard-launch.mjs';
import { createClient, unwrap } from './lib/mcp-stdio-client.mjs';
import { pixelDiff } from './lib/pixel-diff.mjs';
import {
  DETAIL_PANEL_TEST_IDS,
  READ_TOOLS,
  checkHttpStatus,
  checkPage,
  checkToolResult,
  findBadTokensInPayload,
  findOffscreenPanels,
  isDomainRefusal,
  localMondayOf,
} from './lib/sweep-checks.mjs';
import { columnKey, renderContactSheet } from './lib/sweep-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(REPO_ROOT, 'sweep-out');
const CLOCK_PRELOAD = path.join(REPO_ROOT, 'scripts', 'fixed-clock-preload.mjs');
const PERSONAS = path.join(REPO_ROOT, 'dist/docs/personas/index.js');
const SEED_FILE = path.join(REPO_ROOT, 'dist/docs/personas/seed-file.js');
const SHOTS = path.join(REPO_ROOT, 'dist/docs/capture-shots.js');
const SPA_INDEX = path.join(REPO_ROOT, 'dist/spa/index.html');

const SEED_NOW = new Date(2026, 9, 12, 5, 0);
const VIEW_NOW = new Date(2026, 9, 11, 23, 30);
const VIEWED_AT_SEED = new Set(['messy']);

const ROUTES = ['#/', '#/summary', '#/plan', '#/goals', '#/checkin', '#/body', '#/body/chest'];
const UNITS = ['lb', 'kg'];
const DISPLAY_UNIT_KEY = 'voltras.live.displayUnit';
const ENDPOINTS = [
  '/api/health',
  '/api/snapshot',
  '/api/history',
  '/api/session-plan',
  '/api/exercises',
  '/api/plan-tree',
  '/api/muscle-plan',
  '/api/muscle-week',
  '/api/muscle-strength',
  '/api/muscle-recovery',
  '/api/goals',
  '/api/banners',
  '/api/activity',
  '/api/session-review',
];
/** The plan's per-call budget: a read slower than this on the `year` persona is a finding. */
const ENDPOINT_BUDGET_MS = 2_000;
const SETTLE_SAMPLE_MS = 300;
const SETTLE_ROUNDS = 3;
const SETTLE_TIMEOUT_MS = 12_000;
const TOOL_TIMEOUT_MS = 60_000;
/** Titan's side sheet slides in over 400 ms; the margin covers a late first frame. */
const CLOCK_ANIMATION_MS = 1_000;

const log = (...args) => console.error('[sweep]', ...args);

function parseArgs(argv) {
  const args = { personas: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--persona') args.personas = argv[++i].split(',');
    else if (arg.startsWith('--persona=')) args.personas = arg.slice(10).split(',');
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function runName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** The newest earlier run with a findings.json, whose PNGs "changed" compares against. */
function previousRunDir(currentDir) {
  if (!fs.existsSync(OUT_ROOT)) return null;
  const earlier = fs
    .readdirSync(OUT_ROOT)
    .map((name) => path.join(OUT_ROOT, name))
    .filter((dir) => dir !== currentDir && fs.existsSync(path.join(dir, 'findings.json')))
    .sort();
  return earlier.at(-1) ?? null;
}

// ── the server: endpoints and tools ────────────────────────────────────────

async function fetchEndpoint(port, persona, endpoint) {
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  const where = { persona, endpoint };
  const findings = [
    ...checkHttpStatus({ persona, endpoint, status: res.status }),
    ...findBadTokensInPayload(text).map((finding) => ({ ...finding, ...where })),
  ];
  if (ms > ENDPOINT_BUDGET_MS) findings.push({ kind: 'slow', ...where, detail: `${ms} ms` });
  return { status: res.status, text, findings };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(request, name, args) {
  const result = unwrap(await request('tools/call', { name, arguments: args }), name);
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
  return { isError: result.isError === true, text, json: parseJson(text) };
}

async function allSessions(request) {
  const sessions = [];
  for (let offset = 0; ; offset += 200) {
    const page = await callTool(request, 'session.list', { kind: 'any', limit: 200, offset });
    const batch = Array.isArray(page.json) ? page.json : [];
    sessions.push(...batch);
    if (batch.length < 200) return sessions;
  }
}

const firstId = (list) => (Array.isArray(list) && list.length > 0 ? list[0].id : null);

/** The ids the read tools take, found by reading the store through the tools themselves. */
async function toolContext(request, sessions) {
  const latestSessionId = sessions[0]?.id ?? null;
  const latest = latestSessionId
    ? (await callTool(request, 'session.get', { id: latestSessionId })).json
    : null;
  const sets = latest?.sets ?? [];
  const exerciseId =
    sets.find((set) => set.exerciseId)?.exerciseId ?? sessions[0]?.exerciseId ?? null;
  const exerciseSessions = sessions
    .filter((session) => exerciseId !== null && session.exerciseId === exerciseId)
    .map((session) => session.id)
    .reverse();
  const programs = (await callTool(request, 'plan.program.list', {})).json;
  const programId = firstId(programs?.programs ?? programs);
  const blocks = programId
    ? (await callTool(request, 'plan.block.list_for_program', { programId })).json
    : null;
  const blockId = firstId(blocks?.blocks ?? blocks);
  const weeks = blockId
    ? (await callTool(request, 'plan.week.list_for_block', { blockId })).json
    : null;
  const weekId = firstId(weeks?.weeks ?? weeks);
  const templates = weekId
    ? (await callTool(request, 'plan.template.list_for_week', { weekId })).json
    : null;
  const templateId = firstId(templates?.templates ?? templates);
  return {
    latestSessionId,
    setId: sets[0]?.id ?? null,
    exerciseId,
    exerciseSessions,
    programId,
    blockId,
    weekId,
    templateId,
  };
}

async function sweepTools(request, persona, sessions) {
  const ctx = await toolContext(request, sessions);
  const findings = [];
  const skipped = [];
  const refusals = [];
  for (const tool of READ_TOOLS) {
    const label = tool.label ?? tool.name;
    const args = tool.args(ctx);
    if (!args) {
      skipped.push(label);
      continue;
    }
    const result = await callTool(request, tool.name, args);
    if (isDomainRefusal(result)) refusals.push(`${label}: ${result.json.code}`);
    findings.push(...checkToolResult({ persona, tool: label, ...result }));
  }
  return { findings, skipped, refusals };
}

async function sweepEndpoints(port, persona, sessions) {
  const findings = [];
  for (const endpoint of ENDPOINTS) {
    findings.push(...(await fetchEndpoint(port, persona, endpoint)).findings);
  }
  const goals = parseJson((await fetchEndpoint(port, persona, '/api/goals')).text);
  for (const entry of goals?.priorities ?? []) {
    const endpoint = `/api/goal-progress?priorityId=${encodeURIComponent(entry.priority.id)}`;
    findings.push(...(await fetchEndpoint(port, persona, endpoint)).findings);
  }
  for (const id of ['latest', ...sessions.map((session) => session.id)]) {
    const endpoint = `/api/session-summary/${encodeURIComponent(id)}`;
    findings.push(...(await fetchEndpoint(port, persona, endpoint)).findings);
  }
  return findings;
}

// ── the pages ──────────────────────────────────────────────────────────────

/**
 * The page's rendered text, whitespace collapsed, with the live page's lbs/kg
 * toggle taken out: its "lbs" label sits beside whatever number precedes it.
 */
async function pageText(page) {
  const raw = await page.evaluate(() => {
    const toggles = [...document.querySelectorAll('body *')].filter(
      (el) => el.childElementCount >= 2 && el.textContent.replace(/\s+/g, '') === 'lbskg',
    );
    const toggle = toggles.at(-1);
    const text = document.body.innerText;
    return toggle === undefined ? text : text.replace(toggle.innerText, ' ');
  });
  return raw.replace(/\s+/g, ' ').trim();
}

/** Wait until the page's text stops changing; a page that never settles is a finding. */
async function settle(page) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = null;
  let streak = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(SETTLE_SAMPLE_MS);
    const text = await pageText(page);
    streak = text === last && text.length > 0 && !/\bLoading\b/i.test(text) ? streak + 1 : 0;
    if (streak >= SETTLE_ROUNDS) return true;
    last = text;
  }
  return false;
}

function watchPage(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const where = message.location()?.url ?? '';
    errors.push({ kind: 'console', detail: `${message.text()} ${where}`.trim() });
  });
  page.on('pageerror', (error) => errors.push({ kind: 'page-error', detail: error.message }));
  return errors;
}

async function settlePaint(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/**
 * Finish any entrance that reads `Date.now()` per frame, which the pinned clock
 * would hold at its first frame forever (Body's side sheet would stay off screen):
 * step the clock past it, let it draw, then pin the clock back. The same move as
 * the capture harness's `finishClockDrivenAnimation`, applied to every page.
 */
async function finishClockDrivenAnimations(page, viewNow) {
  await page.clock.setFixedTime(viewNow.getTime() + CLOCK_ANIMATION_MS);
  await settlePaint(page);
  await page.clock.setFixedTime(viewNow);
  await settlePaint(page);
}

/** The box of every detail panel on the page, for the geometry check. */
async function detailPanelBoxes(page) {
  return page.evaluate((testIds) => {
    return testIds.flatMap((testId) =>
      [...document.querySelectorAll(`[data-testid="${testId}"]`)].map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { testId, x, y, width, height };
      }),
    );
  }, DETAIL_PANEL_TEST_IDS);
}

async function captureCell(context, origin, cell, runDir) {
  const page = await context.newPage();
  const errors = watchPage(page);
  try {
    await page.goto(`${origin}/app${cell.route}`, { waitUntil: 'domcontentloaded' });
    const settled = await settle(page);
    await finishClockDrivenAnimations(page, cell.viewNow);
    const png = path.join(cell.persona, `${columnKey(cell)}.png`);
    await page.screenshot({ path: path.join(runDir, png), fullPage: true });
    const text = await pageText(page);
    const boxes = await detailPanelBoxes(page);
    const findings = [
      ...(settled ? [] : [{ kind: 'unsettled', detail: 'page text never stopped changing' }]),
      ...checkPage({ ...cell, text, expectedMonday: cell.expectedMonday }),
      ...findOffscreenPanels(boxes, page.viewportSize()),
      ...errors,
    ];
    return { ...cell, png, findings };
  } catch (err) {
    return { ...cell, png: null, findings: [...errors, { kind: 'harness', detail: err.message }] };
  } finally {
    await page.close();
  }
}

async function newContext(browser, viewport, unit, viewNow) {
  const context = await browser.newContext({
    viewport,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    reducedMotion: 'reduce',
  });
  await context.clock.setFixedTime(viewNow);
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [DISPLAY_UNIT_KEY, unit === 'kg' ? 'kg' : 'lbs'],
  );
  return context;
}

async function sweepPages(browser, port, persona, viewNow, runDir, viewports) {
  fs.mkdirSync(path.join(runDir, persona), { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const expectedMonday = localMondayOf(viewNow);
  const cells = [];
  for (const unit of UNITS) {
    for (const [viewport, size] of Object.entries(viewports)) {
      const context = await newContext(browser, size, unit, viewNow);
      for (const route of ROUTES) {
        const cell = { persona, route, viewport, unit, expectedMonday };
        const captured = await captureCell(context, origin, { ...cell, viewNow }, runDir);
        delete captured.viewNow;
        cells.push(captured);
      }
      await context.close();
    }
  }
  return cells;
}

// ── one persona ────────────────────────────────────────────────────────────

async function seedPersona(persona, runDir) {
  const { seedPersonaFile } = await import(SEED_FILE);
  const dbDir = path.join(runDir, persona);
  fs.mkdirSync(dbDir, { recursive: true });
  const report = await seedPersonaFile(persona, scenarioDbPath(dbDir, 'store'), SEED_NOW);
  log(`${persona}: seeded ${report.sessions} sessions, ${report.sets} sets, ${report.goals} goals`);
  return dbDir;
}

async function sweepPersona(browser, persona, runDir, viewports) {
  const dbDir = await seedPersona(persona, runDir);
  const viewNow = VIEWED_AT_SEED.has(persona) ? SEED_NOW : VIEW_NOW;
  const scene = await startScenario({ name: 'store', driver: null, args: [] }, dbDir, {
    log,
    clientName: 'persona-sweep',
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { VMCP_CLOCK_OFFSET_MS: String(viewNow.getTime() - Date.now()) },
  });
  try {
    const request = createClient(scene.child, { timeoutMs: TOOL_TIMEOUT_MS });
    const sessions = await allSessions(request);
    const tools = await sweepTools(request, persona, sessions);
    const endpointFindings = await sweepEndpoints(scene.port, persona, sessions);
    const cells = await sweepPages(browser, scene.port, persona, viewNow, runDir, viewports);
    const red = cells.filter((cell) => cell.findings.length > 0).length;
    log(`${persona}: ${cells.length} cells, ${red} red, ${tools.skipped.length} tools skipped`);
    return {
      cells,
      apiFindings: [...endpointFindings, ...tools.findings],
      skippedTools: { [persona]: tools.skipped },
      toolRefusals: { [persona]: tools.refusals },
    };
  } finally {
    scene.stop();
  }
}

/** Mark each cell whose PNG differs from the previous run's, with the pixel diff's summary. */
async function markChanged(browser, cells, runDir, previousDir) {
  if (previousDir === null) return;
  for (const cell of cells) {
    if (cell.png === null) continue;
    const before = path.join(previousDir, cell.png);
    if (!fs.existsSync(before)) continue;
    const a = fs.readFileSync(before);
    const b = fs.readFileSync(path.join(runDir, cell.png));
    if (!a.equals(b)) cell.changed = await pixelDiff(browser, a, b);
  }
}

async function main() {
  for (const file of [SEED_FILE, SHOTS, SPA_INDEX]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run the build first`);
  }
  delete process.env.VMCP_DEBUG_TOOLS;
  const args = parseArgs(process.argv.slice(2));
  const { PERSONAS: all } = await import(PERSONAS);
  const { WALL_VIEWPORT, PHONE_VIEWPORT } = await import(SHOTS);
  const personas = args.personas ?? all.map((persona) => persona.id);
  const run = runName();
  const runDir = args.out ?? path.join(OUT_ROOT, run);
  const previousDir = previousRunDir(runDir);
  fs.mkdirSync(runDir, { recursive: true });

  const browser = await chromium.launch();
  const record = {
    run,
    seedNow: SEED_NOW.toISOString(),
    viewNow: VIEW_NOW.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    previousRun: previousDir === null ? null : path.basename(previousDir),
    personas,
    columns: UNITS.flatMap((unit) =>
      ['wall', 'phone'].flatMap((viewport) =>
        ROUTES.map((route) => columnKey({ route, viewport, unit })),
      ),
    ),
    cells: [],
    apiFindings: [],
    skippedTools: {},
    toolRefusals: {},
  };
  try {
    for (const persona of personas) {
      const result = await sweepPersona(browser, persona, runDir, {
        wall: WALL_VIEWPORT,
        phone: PHONE_VIEWPORT,
      });
      record.cells.push(...result.cells);
      record.apiFindings.push(...result.apiFindings);
      Object.assign(record.skippedTools, result.skippedTools);
      Object.assign(record.toolRefusals, result.toolRefusals);
    }
    await markChanged(browser, record.cells, runDir, previousDir);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(runDir, 'findings.json'), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'index.html'), renderContactSheet(record));
  const red = record.cells.filter((cell) => cell.findings.length > 0).length;
  log(
    `${record.cells.length} cells, ${red} red, ${record.apiFindings.length} endpoint/tool findings`,
  );
  console.log(path.join(runDir, 'index.html'));
}

main().catch((err) => {
  console.error('[sweep] FAIL:', err.stack ?? err.message);
  process.exit(1);
});
