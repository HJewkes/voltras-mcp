#!/usr/bin/env node
// seed-persona: write one synthetic lifter to a new store file (VW-942).
//
// Usage:
//   npm run build
//   node scripts/seed-persona.mjs <persona> <db-path> [--clock=ISO]
//
// `--clock` is the "now" the persona's history ends at; it defaults to the real
// clock. The command refuses any path under `.voltras` and any file already
// there, so it can never write over the real store. The personas are defined in
// `src/docs/personas/`; run it with no arguments to list them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAS = path.join(REPO_ROOT, 'dist/docs/personas/index.js');
const SEED_FILE = path.join(REPO_ROOT, 'dist/docs/personas/seed-file.js');

function parseArgs(argv, known) {
  const args = { persona: null, dbPath: null, clock: new Date() };
  for (const arg of argv) {
    if (arg.startsWith('--clock=')) args.clock = parseClock(arg.slice('--clock='.length));
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else if (args.persona === null) args.persona = arg;
    else if (args.dbPath === null) args.dbPath = path.resolve(arg);
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (args.persona === null || args.dbPath === null) {
    throw new Error(`usage: seed-persona <persona> <db-path> [--clock=ISO]; personas: ${known}`);
  }
  return args;
}

function parseClock(value) {
  const clock = new Date(value);
  if (Number.isNaN(clock.getTime())) throw new Error(`--clock is not a date: ${value}`);
  return clock;
}

async function main() {
  if (!fs.existsSync(SEED_FILE)) throw new Error(`${SEED_FILE} is missing — run \`npm run build\``);
  const { PERSONAS: personas } = await import(PERSONAS);
  const { seedPersonaFile } = await import(SEED_FILE);
  const known = personas.map((persona) => persona.id).join(', ');
  const args = parseArgs(process.argv.slice(2), known);
  const started = performance.now();
  const report = await seedPersonaFile(args.persona, args.dbPath, args.clock);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `[seed-persona] ${args.persona}: ${report.sessions} sessions, ${report.sets} sets, ` +
      `${report.weighIns} weigh-ins, ${report.checkins} check-ins, ${report.goals} goals ` +
      `in ${seconds} s`,
  );
  console.log(args.dbPath);
}

main().catch((err) => {
  console.error('[seed-persona] FAIL:', err.message);
  process.exit(1);
});
