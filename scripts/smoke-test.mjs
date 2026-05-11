#!/usr/bin/env node
// Smoke test: boot mcp via stdio with mock adapter, send tools/list, verify
// every tool registered correctly. Catches register* wiring issues that
// unit tests miss.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../dist/bin.js');

const EXPECTED_NEW_TOOLS = [
  // mcp-safe-local
  'slot.identify',
  'slot.swap',
  'bilateral.cascade',
  'progression.get_for_exercise',
  'isometric.measure_max',
  'isometric.measure_imbalance',
  'device.exit_guided_load',
  // mcp-plan-stack
  'plan.program.create',
  'plan.program.list',
  'plan.program.get',
  'plan.program.archive',
  'plan.block.create',
  'plan.block.list_for_program',
  'plan.week.create',
  'plan.week.list_for_block',
  'plan.template.create',
  'plan.template.get',
  'plan.template.list_for_week',
  'plan.exercise.create',
  'plan.exercise.list_for_template',
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
];

const child = spawn(process.execPath, [binPath], {
  env: { ...process.env, VOLTRA_ADAPTER: 'mock', VOLTRA_LOG_LEVEL: 'warn' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuffer = '';
const responses = new Map();
let nextId = 1;

function sendRequest(method, params) {
  const id = nextId++;
  const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  child.stdin.write(req);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    responses.set(id, { resolve, reject, timeout });
  });
}

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && responses.has(msg.id)) {
        const { resolve, timeout } = responses.get(msg.id);
        clearTimeout(timeout);
        responses.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // not JSON-RPC; ignore (could be log noise)
    }
  }
});

let stderrBuffer = '';
child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[smoke] mcp exited with code ${code}`);
    if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
    process.exit(1);
  }
});

async function main() {
  // Initialize MCP session
  const init = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.1' },
  });
  if (init.error) {
    console.error('[smoke] initialize failed:', JSON.stringify(init.error));
    process.exit(1);
  }
  console.log('[smoke] initialize OK');

  // Required notification per MCP protocol
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Wait briefly for bootstrap to swap placeholders for real handlers
  await new Promise((r) => setTimeout(r, 1500));

  // List tools
  const listResp = await sendRequest('tools/list', {});
  if (listResp.error) {
    console.error('[smoke] tools/list failed:', JSON.stringify(listResp.error));
    process.exit(1);
  }

  const toolNames = new Set(listResp.result.tools.map((t) => t.name));
  console.log(`[smoke] tools/list returned ${toolNames.size} tools`);

  const missing = EXPECTED_NEW_TOOLS.filter((n) => !toolNames.has(n));
  if (missing.length > 0) {
    console.error('[smoke] FAIL — missing expected tools:');
    missing.forEach((n) => console.error('  ', n));
    process.exit(1);
  }

  console.log('[smoke] PASS — all 22 new tools present');
  console.log('[smoke] Sample new tools:');
  for (const name of EXPECTED_NEW_TOOLS.slice(0, 5)) {
    const tool = listResp.result.tools.find((t) => t.name === name);
    console.log(`  ${name}: ${tool.description?.slice(0, 80) ?? '(no desc)'}`);
  }

  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] crash:', err.message);
  if (stderrBuffer) console.error('stderr:', stderrBuffer.slice(-2000));
  child.kill();
  process.exit(1);
});
