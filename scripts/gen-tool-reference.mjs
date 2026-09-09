#!/usr/bin/env node
// Generate the published capability reference from the tool registry.
//
// The README's tool table is hand-maintained, which is fine for a file people
// edit and wrong for a published page: it reflows on every row edit (so any two
// PRs touching it conflict) and a drifted page is worse than no page. So this
// boots the server over stdio against the MOCK adapter and asks it — descriptions
// taken from `tools/list` cannot drift from what a client actually sees.
//
// Usage: node scripts/gen-tool-reference.mjs [--out site] [--report path.json]

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import prettier from 'prettier';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');
const PUSH_EVENTS_DOC = path.join(REPO_ROOT, 'docs/push-events.md');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const BOOT_SETTLE_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = { out: path.join(REPO_ROOT, 'site'), report: null };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--out') args.out = path.resolve(value);
    else if (argv[i] === '--report') args.report = path.resolve(value);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/** Build when `dist` is missing or older than `src`, so a stale dist never renders. */
function ensureBuild() {
  const built = fs.existsSync(BIN_PATH) ? fs.statSync(BIN_PATH).mtimeMs : 0;
  if (built > newestSourceMtime(path.join(REPO_ROOT, 'src'))) return;
  const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('tsc failed; cannot generate the reference');
}

/**
 * Env for the child server. Isolated on purpose: the default store path is the
 * human's real training history and the default dashboard port may already be
 * bound by a live session.
 */
function isolatedEnv(scratchDir) {
  return {
    VOLTRA_ADAPTER: 'mock',
    VMCP_LOG_LEVEL: 'error',
    VMCP_DB_PATH: path.join(scratchDir, 'reference.sqlite'),
    VMCP_SLOT_BINDINGS_PATH: path.join(scratchDir, 'slot-bindings.json'),
    VMCP_DASHBOARD_PORT: 'off',
  };
}

function createClient(child) {
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  return function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
    });
  };
}

function unwrap(response, method) {
  if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

/** Boot the mock server and read back its whole advertised surface. */
async function readServerSurface(scratchDir) {
  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...isolatedEnv(scratchDir) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const request = createClient(child);
    unwrap(
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gen-tool-reference', version: '1' },
      }),
      'initialize',
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    // The bootstrap swaps placeholder handlers for real ones after the handshake.
    await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS));
    return {
      tools: unwrap(await request('tools/list', {}), 'tools/list').tools,
      resources: unwrap(await request('resources/list', {}), 'resources/list').resources,
      resourceTemplates: unwrap(
        await request('resources/templates/list', {}),
        'resources/templates/list',
      ).resourceTemplates,
    };
  } finally {
    child.kill();
  }
}

/** Rows of the `## Events` table in docs/push-events.md, in document order. */
function readPushEvents() {
  const doc = fs.readFileSync(PUSH_EVENTS_DOC, 'utf8');
  const section = /\n## Events\n([\s\S]*?)\n\n/.exec(doc);
  if (!section) throw new Error('docs/push-events.md has no "## Events" table');
  const rows = [];
  for (const line of section[1].split('\n')) {
    if (!line.startsWith('|') || /^\|[\s|:-]+\|$/.test(line)) continue;
    const cells = line.slice(1, line.lastIndexOf('|')).split('|');
    if (cells.length !== 3) throw new Error(`unexpected push-event row: ${line}`);
    const [event, firesWhen, autoStops] = cells.map((cell) => cell.trim());
    if (event === 'Event') continue;
    rows.push({ event, firesWhen, autoStops });
  }
  if (rows.length === 0) throw new Error('docs/push-events.md "## Events" table is empty');
  return rows;
}

/** Every markdown page this repo already publishes, for vocabulary harvesting. */
function readPublishedMarkdown() {
  const pages = [fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) pages.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(DOCS_DIR);
  return pages;
}

async function formatWith(prettierConfig, filepath, text) {
  return prettier.format(text, { ...prettierConfig, filepath });
}

async function writePages(outDir, pages, sidebar) {
  const referenceDir = path.join(outDir, 'reference');
  fs.rmSync(referenceDir, { recursive: true, force: true });
  fs.mkdirSync(referenceDir, { recursive: true });
  const config = (await prettier.resolveConfig(path.join(REPO_ROOT, 'site/index.md'))) ?? {};
  for (const [relative, body] of pages) {
    const target = path.join(outDir, relative);
    fs.writeFileSync(target, await formatWith(config, target, body));
  }
  const sidebarPath = path.join(outDir, '.vitepress/reference-sidebar.json');
  fs.mkdirSync(path.dirname(sidebarPath), { recursive: true });
  const json = `${JSON.stringify(sidebar, null, 2)}\n`;
  fs.writeFileSync(sidebarPath, await formatWith(config, sidebarPath, json));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureBuild();
  const { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } = await import(
    path.join(REPO_ROOT, 'dist/tool-registry.js')
  );
  const { buildReference } = await import(path.join(REPO_ROOT, 'dist/docs/reference-pages.js'));
  const { createProtocolGuard } = await import(path.join(REPO_ROOT, 'dist/docs/protocol-guard.js'));
  const { derivePublicVocabulary } = await import(
    path.join(REPO_ROOT, 'dist/docs/public-vocabulary.js')
  );

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-reference-'));
  let surface;
  try {
    surface = await readServerSurface(scratchDir);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  assertRegistryMatchesServer(surface.tools, CORE_TOOL_NAMES, MOCK_TOOL_NAMES);

  const guard = createProtocolGuard(
    derivePublicVocabulary({
      tools: surface.tools,
      resourceUris: [
        ...surface.resources.map((resource) => resource.uri),
        ...surface.resourceTemplates.map((template) => template.uriTemplate),
      ],
      publishedMarkdown: readPublishedMarkdown(),
    }),
  );

  const reference = buildReference({
    guard,
    coreToolNames: CORE_TOOL_NAMES,
    mockToolNames: MOCK_TOOL_NAMES,
    tools: surface.tools,
    resources: surface.resources,
    resourceTemplates: surface.resourceTemplates,
    pushEvents: readPushEvents(),
  });
  await writePages(args.out, reference.pages, reference.sidebar);
  assertNoProtocolDetail(args.out, reference.pages, guard);

  const report = {
    pageCount: reference.pages.size,
    coreToolCount: CORE_TOOL_NAMES.length,
    mockToolCount: MOCK_TOOL_NAMES.length,
    redactions: reference.redactions,
    isolation: isolatedEnv('<scratch>'),
  };
  if (args.report) fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[reference] ${report.pageCount} pages, ${report.coreToolCount} core tools, ` +
      `${report.coreToolCount + report.mockToolCount} in mock mode`,
  );
}

/** The registry is canonical; a server that disagrees means a missed registration. */
function assertRegistryMatchesServer(tools, coreNames, mockNames) {
  const live = new Set(tools.map((tool) => tool.name));
  const expected = new Set([...coreNames, ...mockNames]);
  const missing = [...expected].filter((name) => !live.has(name));
  const extra = [...live].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `tool-registry.ts and the booted server disagree — missing: ${missing.join(', ') || 'none'}; ` +
        `unregistered: ${extra.join(', ') || 'none'}`,
    );
  }
}

// Fail the build rather than publish a byte, opcode, offset or register name.
// The message names the file and the pattern kind but never the token itself —
// a build log is as public as the page it refused to publish.
function assertNoProtocolDetail(outDir, pages, guard) {
  const offenders = [];
  for (const relative of pages.keys()) {
    const text = fs.readFileSync(path.join(outDir, relative), 'utf8');
    for (const match of guard.find(text)) {
      offenders.push(`${relative}: ${match.kind}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `protocol detail reached a generated page (${offenders.length} hits): ${offenders.join('; ')}`,
    );
  }
}

main().catch((error) => {
  console.error(`[reference] ${error.message}`);
  process.exit(1);
});
