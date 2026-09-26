// CLI: truecoach-retro <records.jsonl> <checkins.jsonl> <exercise-map.json> --out <report.md> [--json <data.json>] [--programme-split YYYY-MM-DD] [--boundary-decisions <boundary-decisions.json>] [--warmup-share <percent>]

import { readFileSync, writeFileSync } from 'node:fs';

import { buildContext } from './context.js';
import { UNDIVIDED_WARMUP_LOAD_SHARE } from './missed-targets.js';
import { buildRetroData } from './data.js';
import { parseExerciseMap } from './exercise-map.js';
import { parseBoundaryDecisions, type BoundaryDecision } from './segmentation.js';
import { renderReport } from './report.js';
import type { CheckinRecord, SetRecord } from './types.js';

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

function flag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function readDecisions(path: string | null): BoundaryDecision[] | null {
  return path === null ? null : parseBoundaryDecisions(JSON.parse(readFileSync(path, 'utf8')));
}

function readWarmupShare(raw: string | null): number {
  if (raw === null) return UNDIVIDED_WARMUP_LOAD_SHARE;
  const percent = Number(raw);
  if (!(percent > 0 && percent <= 100)) {
    console.error(`--warmup-share takes a percent above 0 and up to 100, got "${raw}"`);
    process.exit(2);
  }
  return percent / 100;
}

function main(args: readonly string[]): void {
  const [recordsPath, checkinsPath, mapPath] = args;
  const out = flag(args, '--out');
  if (
    recordsPath === undefined ||
    checkinsPath === undefined ||
    mapPath === undefined ||
    out === null
  ) {
    console.error(
      'usage: truecoach-retro <records.jsonl> <checkins.jsonl> <exercise-map.json> --out <report.md> [--json <data.json>] [--programme-split YYYY-MM-DD] [--boundary-decisions <boundary-decisions.json>] [--warmup-share <percent>]',
    );
    process.exit(2);
  }
  const map = parseExerciseMap(JSON.parse(readFileSync(mapPath, 'utf8')));
  const ctx = buildContext(
    readJsonl<SetRecord>(recordsPath),
    readJsonl<CheckinRecord>(checkinsPath),
    map,
    flag(args, '--programme-split'),
    readDecisions(flag(args, '--boundary-decisions')),
    readWarmupShare(flag(args, '--warmup-share')),
  );
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(out, renderReport(ctx, today));
  console.error(`wrote ${out}`);
  const json = flag(args, '--json');
  if (json !== null) {
    writeFileSync(json, `${JSON.stringify(buildRetroData(ctx, today), null, 2)}\n`);
    console.error(`wrote ${json}`);
  }
}

main(process.argv.slice(2));
