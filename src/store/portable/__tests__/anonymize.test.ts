// The anonymising exporter over a store with a row in every table (VW-941).
//
// Pinned west of UTC, where a whole-week shift that moved milliseconds instead
// of local calendar days would move the local hour across a daylight-saving
// change; under UTC that mutant passes.
//
// MUTATION CONTROL. Mapping `sessions.notes` to `keep` fails the planted-string
// case; making `checkCovered` skip unlisted columns fails the unknown-column
// case; shifting instants by a fixed span of milliseconds fails the local-hour
// case. PLANTED is written by hand and never derived from TABLE_RULES, so a
// rule loosened in the rules file cannot loosen the test with it.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedEveryTable } from '../../__tests__/fixtures/every-table-store.js';
import { anonymizeExport } from '../anonymize.js';
import { TABLE_RULES } from '../anonymize-rules.js';
import { shiftTimestamp } from '../anonymize-values.js';
import { exportStore } from '../export.js';
import { importStore } from '../import.js';
import { MANIFEST_FILE, type ExportManifest, type TableManifest } from '../manifest.js';
import { hashText } from '../table-file.js';
import { verifyStore } from '../verify.js';

let seeded: string;

/** One seeded export per file, copied per test: seeding walks every migration and costs seconds. */
beforeAll(async () => {
  seeded = mkdtempSync(join(tmpdir(), 'vmcp-anonymize-seed-'));
  await seedEveryTable(join(seeded, 'source.sqlite'));
  exportStore(join(seeded, 'source.sqlite'), join(seeded, 'export'));
});

afterAll(() => {
  rmSync(seeded, { recursive: true, force: true });
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

type Row = Record<string, unknown>;

/** Every column that can hold something the lifter typed, a device id, or a lifter label. */
const PLANTED: readonly (readonly [string, string])[] = [
  ['sessions', 'notes'],
  ['sessions', 'exercise_name'],
  ['sessions', 'lifter'],
  ['users', 'display_name'],
  ['body_metrics', 'notes'],
  ['body_metrics', 'measurement_protocol'],
  ['limitations', 'notes'],
  ['limitations', 'body_region'],
  ['self_reports', 'value_text'],
  ['commitments', 'lifter_if_then'],
  ['commitments', 'lifter_wording'],
  ['training_programs', 'name'],
  ['training_programs', 'description'],
  ['training_blocks', 'name'],
  ['training_blocks', 'focus'],
  ['training_blocks', 'notes'],
  ['training_weeks', 'name'],
  ['training_weeks', 'phase_type'],
  ['workout_templates', 'name'],
  ['workout_templates', 'notes'],
  ['workout_templates', 'day_label'],
  ['workout_templates', 'external_id'],
  ['planned_exercises', 'notes'],
  ['planned_exercises', 'external_id'],
  ['exercise_setups', 'label'],
  ['disruption_windows', 'reason'],
  ['exercise_chapters', 'reason'],
  ['exercise_substitutions', 'rationale_text'],
  ['block_schedules', 'reason'],
  ['training_profile', 'goal'],
  ['training_profile', 'current_baseline'],
  ['training_profile', 'target'],
  ['training_profile', 'injuries_json'],
  ['training_profile', 'named_program_history'],
  ['accountability_state', 'ghost_sends_json'],
  ['accountability_state', 'last_proactive_sends_json'],
  ['sets', 'lifter'],
  ['failure_anchors', 'lifter'],
  ['isometric_trials', 'device_id'],
  ['device_events', 'detail_json'],
  ['idle_reps', 'payload'],
  ['cue_state', 'fault_code'],
  ['ui_actions', 'reason'],
];
const DEVICE_ID = 'PLANT-device-serial';
/** The fixture's exercise is not in the catalog, so its id and name must not survive either. */
const NON_CATALOG = ['ex-back-squat', 'ex-front-squat', 'Back Squat'];

let dir: string;
let exportDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-anonymize-'));
  exportDir = join(dir, 'export');
  cpSync(join(seeded, 'export'), exportDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readManifest(at: string): ExportManifest {
  return JSON.parse(readFileSync(join(at, MANIFEST_FILE), 'utf8')) as ExportManifest;
}

function readRows(at: string, table: string): Row[] {
  const text = readFileSync(join(at, `${table}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);
}

/** Rewrites one table of an export in place, keeping its manifest honest. */
function editTable(table: string, edit: (row: Row) => Row, columns?: string[]): void {
  const text = readRows(exportDir, table)
    .map((r) => `${JSON.stringify(edit(r))}\n`)
    .join('');
  writeFileSync(join(exportDir, `${table}.jsonl`), text);
  const manifest = readManifest(exportDir);
  const tables = manifest.tables.map((t: TableManifest) =>
    t.name === table ? { ...t, sha256: hashText(text), columns: columns ?? t.columns } : t,
  );
  writeFileSync(join(exportDir, MANIFEST_FILE), JSON.stringify({ ...manifest, tables }));
}

function plantEverything(): string[] {
  for (const [table, column] of PLANTED) {
    const value = `PLANT-${table}-${column}`;
    editTable(table, (r) => ({
      ...r,
      [column]: column.endsWith('_json') ? JSON.stringify([value]) : value,
    }));
  }
  for (const table of ['sets', 'device_bindings'])
    editTable(table, (r) => ({ ...r, device_id: DEVICE_ID }));
  return [...PLANTED.map(([t, c]) => `PLANT-${t}-${c}`), DEVICE_ID, ...NON_CATALOG];
}

function outputText(outDir: string): string {
  return readdirSync(outDir)
    .map((f) => readFileSync(join(outDir, f), 'utf8'))
    .join('\n');
}

describe('anonymize strips what identifies the lifter', () => {
  it('leaves no planted string anywhere in the output', () => {
    const planted = plantEverything();
    const outDir = join(dir, 'anon');

    anonymizeExport(exportDir, outDir, { seed: '2' });

    const text = outputText(outDir);
    expect(planted.filter((p) => text.includes(p))).toEqual([]);
  });

  it('gives names numbered stand-ins and keeps a device id joinable across tables', () => {
    plantEverything();
    const outDir = join(dir, 'anon');

    anonymizeExport(exportDir, outDir, { seed: '2' });

    expect(readRows(outDir, 'training_programs')[0]?.name).toBe('Program 1');
    expect(readRows(outDir, 'workout_templates')[0]?.name).toBe('Workout A');
    expect(readRows(outDir, 'sessions')[0]?.exercise_name).toBe('Custom exercise 1');
    expect(readRows(outDir, 'sets')[0]?.device_id).toBe(
      readRows(outDir, 'device_bindings')[0]?.device_id,
    );
  });

  it('writes the dropped tables empty', () => {
    const outDir = join(dir, 'anon');

    const manifest = anonymizeExport(exportDir, outDir, { seed: '2' });

    const empty = manifest.tables.filter((t) => t.rowCount === 0).map((t) => t.name);
    expect(empty).toEqual(['cue_state', 'device_events', 'idle_reps', 'ui_actions']);
  });

  it('empties rep sample arrays and keeps the phase aggregates and the derived block', () => {
    const sample = { timestamp: 1, velocity: 2, force: 3, position: 4 };
    const derived = { rep_number: 1, rom_m: 0.6, impulse_lb_s: 10 };
    editTable('reps', (r) => {
      const rep = JSON.parse(String(r.payload)) as { concentric: Row };
      return {
        ...r,
        payload: JSON.stringify({
          ...rep,
          concentric: { ...rep.concentric, samples: [sample] },
          derived,
        }),
      };
    });
    const outDir = join(dir, 'anon');

    anonymizeExport(exportDir, outDir, { seed: '2' });

    const rep = JSON.parse(String(readRows(outDir, 'reps')[0]?.payload)) as {
      concentric: Row;
      derived: Row;
    };
    expect(rep.concentric.samples).toEqual([]);
    expect(rep.concentric.peakVelocity).toBe(0.5);
    expect(rep.derived).toEqual(derived);
  });
});

describe('anonymize is default-deny', () => {
  it('names every table and column of the current schema, and nothing else', () => {
    const manifest = readManifest(exportDir);

    expect(Object.keys(TABLE_RULES).sort()).toEqual(manifest.tables.map((t) => t.name));
    for (const table of manifest.tables) {
      const rule = TABLE_RULES[table.name];
      if (rule !== 'drop')
        expect([table.name, Object.keys(rule ?? {}).sort()]).toEqual([table.name, table.columns]);
    }
  });

  it('fails, writing nothing, on a column the allowlist does not name', () => {
    const columns = [
      ...(readManifest(exportDir).tables.find((t) => t.name === 'sessions')?.columns ?? []),
      'mood',
    ];
    editTable('sessions', (r) => ({ ...r, mood: 'PLANT-unknown' }), columns.sort());
    const outDir = join(dir, 'anon');

    expect(() => anonymizeExport(exportDir, outDir, { seed: '2' })).toThrow(
      /no rule for sessions\.mood/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it('fails on a table the allowlist does not name', () => {
    writeFileSync(join(exportDir, 'journal.jsonl'), '');
    const manifest = readManifest(exportDir);
    const journal = {
      ...manifest.tables[0],
      name: 'journal',
      file: 'journal.jsonl',
      rowCount: 0,
      sha256: hashText(''),
    };
    writeFileSync(
      join(exportDir, MANIFEST_FILE),
      JSON.stringify({ ...manifest, tables: [...manifest.tables, journal] }),
    );

    expect(() => anonymizeExport(exportDir, join(dir, 'anon'), { seed: '2' })).toThrow(
      /no rule for table journal/,
    );
  });
});

describe('anonymize moves dates by whole local weeks', () => {
  function local(iso: string): string {
    const d = new Date(iso);
    return `${d.getDay()} ${d.getHours()}:${d.getMinutes()}`;
  }

  it('keeps the local weekday and hour of a session across a daylight-saving change', () => {
    const before = readRows(exportDir, 'sessions')[0] as Row;
    const outDir = join(dir, 'anon');

    anonymizeExport(exportDir, outDir, { seed: '2' });

    const after = readRows(outDir, 'sessions')[0] as Row;
    expect(after.started_at).not.toBe(before.started_at);
    // Seed 2 lands the March session in summer time, so its UTC hour moves and its local hour must not.
    expect(new Date(String(after.started_at)).getUTCHours()).not.toBe(
      new Date(String(before.started_at)).getUTCHours(),
    );
    expect(local(String(after.started_at))).toBe(local(String(before.started_at)));
    expect(local(String(after.ended_at))).toBe(local(String(before.ended_at)));
  });

  it('moves a date-only column by the same whole weeks, keeping its weekday', () => {
    const outDir = join(dir, 'anon');

    anonymizeExport(exportDir, outDir, { seed: '2' });

    const startsOn = String(readRows(outDir, 'block_schedules')[0]?.starts_on);
    expect(new Date(`${startsOn}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(startsOn < '2026-03-02').toBe(true);
  });

  it('keeps the local hour when one week back crosses the autumn change', () => {
    const shifted = shiftTimestamp('2026-11-02T17:00:00.000Z', 1, 'test');

    expect(shifted).toBe('2026-10-26T16:00:00.000Z');
    expect(local(shifted)).toBe(local('2026-11-02T17:00:00.000Z'));
  });
});

describe('anonymize output is an export', () => {
  it('imports into a new store that verifies against it', async () => {
    plantEverything();
    const outDir = join(dir, 'anon');
    anonymizeExport(exportDir, outDir, { seed: '2', scale: true });
    const restored = join(dir, 'restored.sqlite');

    await importStore(outDir, restored);

    expect(verifyStore(restored, outDir)).toEqual({ equal: true, differences: [] });
  });

  it('writes the same bytes for the same seed', () => {
    anonymizeExport(exportDir, join(dir, 'one'), { seed: '2' });
    anonymizeExport(exportDir, join(dir, 'two'), { seed: '2' });

    expect(outputText(join(dir, 'two'))).toBe(outputText(join(dir, 'one')));
  });

  it('scales every load by one factor in [0.9, 1.1] only when asked', () => {
    anonymizeExport(exportDir, join(dir, 'plain'), { seed: '2' });
    anonymizeExport(exportDir, join(dir, 'scaled'), { seed: '2', scale: true });

    const plain = readRows(join(dir, 'plain'), 'sets')[0]?.weight_lbs as number;
    const factor = (readRows(join(dir, 'scaled'), 'sets')[0]?.weight_lbs as number) / plain;
    expect(plain).toBe(225);
    expect(factor).toBeGreaterThanOrEqual(0.9);
    expect(factor).toBeLessThanOrEqual(1.1);
    expect(factor).not.toBe(1);
    expect(readRows(join(dir, 'scaled'), 'failure_anchors')[0]?.load_lbs).toBeCloseTo(
      225 * factor,
      9,
    );
  });
});

describe('anonymize refuses a git work tree', () => {
  it('will not write anywhere under a directory holding .git', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    const outDir = join(dir, 'repo', 'fixtures', 'anon');

    expect(() => anonymizeExport(exportDir, outDir, { seed: '2' })).toThrow(/git work tree/);
    expect(existsSync(join(dir, 'repo', 'fixtures'))).toBe(false);
  });
});
