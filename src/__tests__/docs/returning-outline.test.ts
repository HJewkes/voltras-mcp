// The pt-session skill's "Returning after a break" outline (VW-909) must never lead the coach to
// count the gap out loud, and must name only fields `plan.next_workout` really returns.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import { RETURN_CLEARANCES } from '../../profile/return-clearance.js';
import { ProfileSetTrainingBackgroundInput } from '../../schemas/profile.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { seedTrainingDay } from '../fixtures/training-day.js';

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));

const { registerPlanTools } = await import('../../tools/plan-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const SITTINGS_PAGE = fileURLToPath(
  new URL(
    '../../../plugins/voltras-channel/skills/pt-session/references/14-sittings.md',
    import.meta.url,
  ),
);
const HEADING = '## R. Returning after a break';
const NOW = '2026-10-03T12:00:00.000Z';

/** One training history per `reEntry` shape: none, normal, each break band, and back from one. */
const HISTORIES: readonly (readonly string[])[] = [
  [],
  ['2026-10-01'],
  ['2026-09-10'],
  ['2026-08-01'],
  ['2026-01-05'],
  ['2026-08-01', '2026-10-01'],
];

/** Names the outline uses that are not `plan.next_workout` output. */
const NOT_FIELDS = new Set([
  // The `profile.set_training_background` argument that stores the clearance answer, and its values.
  'returnClearance',
  ...RETURN_CLEARANCES,
  // `set.start` watch arguments.
  'velocity_loss_exceeded',
  'pct',
]);

const fields = new Set<string>();
const values = new Set<string>();

function collect(node: unknown, path: string): void {
  if (typeof node === 'string' && /\.(phase|band)$/.test(path)) values.add(node);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, child] of Object.entries(node)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    fields.add(childPath);
    collect(child, childPath);
  }
}

async function seedEmptyProgram(store: SessionStore): Promise<void> {
  await store.putTrainingProgram({ id: 'empty', name: 'Empty', createdAt: NOW });
}

async function seedNotCleared(store: SessionStore): Promise<void> {
  await seedEmptyProgram(store);
  await store.putTrainingProfile({
    userId: 'local',
    updatedAt: NOW,
    returnClearance: { answer: 'not_yet', answeredOn: '2026-10-02' },
  });
}

async function readNextWorkout(
  trainingDays: readonly string[],
  seed: (store: SessionStore) => Promise<void> = seedEmptyProgram,
): Promise<unknown> {
  const store = openTestStore();
  await seed(store);
  for (const day of trainingDays) {
    const at = `${day}T12:00:00.000Z`;
    await seedTrainingDay(store, { id: `s-${day}`, startedAt: at, endedAt: at });
  }
  const state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerPlanTools({} as never, state, placeholders as never);
  const result = await callbacks.get('plan.next_workout')!({});
  await store.close();
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

function returningSection(): string {
  const page = readFileSync(SITTINGS_PAGE, 'utf8');
  const start = page.indexOf(`\n${HEADING}`);
  if (start === -1) return '';
  const end = page.indexOf('\n## ', start + 1);
  return page.slice(start, end === -1 ? undefined : end);
}

/** Every inline code span, plus any camelCase or snake_case word left outside one. */
function namesIn(section: string): string[] {
  const spans = [...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  const prose = section.replace(/`[^`\n]+`/g, ' ');
  const bare = prose.match(/\b[a-z]+(?:[A-Z][A-Za-z]*|(?:_[a-z]+)+)\b/g) ?? [];
  return [...spans, ...bare];
}

function isKnownName(name: string): boolean {
  // A two-digit span is the skill's way of naming a reference page.
  if (/^\d\d$/.test(name)) return true;
  const tools: readonly string[] = CORE_TOOL_NAMES;
  return tools.includes(name) || fields.has(name) || values.has(name) || NOT_FIELDS.has(name);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  for (const history of HISTORIES) collect(await readNextWorkout(history), '');
  // A store with a plan, for the fields of the workout shape.
  collect(await readNextWorkout([], seedOwnerShapedPlan), '');
  // A break under a stored "not yet", for the clearance fields.
  collect(await readNextWorkout(['2026-08-01'], seedNotCleared), '');
});

afterAll(() => {
  vi.useRealTimers();
});

describe('the returning-after-a-break outline', () => {
  it('exists and reads the re-entry result of plan.next_workout', () => {
    const names = namesIn(returningSection());

    expect(names).toEqual(
      expect.arrayContaining(['plan.next_workout', 'reEntry.phase', 'reEntry.windowEndsOn']),
    );
  });

  it('never counts the gap or speaks of a streak', () => {
    const section = returningSection();

    expect(section).not.toBe('');
    expect(section.match(/days?[\s_-]*(since|away)|streak/gi)).toBeNull();
  });

  it('reads the guardrails and the clearance answer from their result fields', () => {
    const names = namesIn(returningSection());

    expect(names).toEqual(
      expect.arrayContaining([
        'reEntry.rule.noFailureSets',
        'reEntry.rule.rirFloor.value.week1',
        'reEntry.rule.rirFloor.value.week2',
        'reEntry.rule.velocityLossCapPct.value',
        'reEntry.clearance',
        'reEntry.blocked',
      ]),
    );
  });

  it('stores the clearance answer through an argument the profile tool accepts', () => {
    expect(Object.keys(ProfileSetTrainingBackgroundInput.shape)).toContain('returnClearance');
    expect(returningSection()).not.toContain('VW-976');
  });

  it('names no field that plan.next_workout does not return', () => {
    expect([...values].sort()).toEqual(
      ['in_gap', 'long', 'medium', 'no_history', 'returning', 'short', 'training'].sort(),
    );
    expect(fields).toContain('reEntry.rule.setsPerMuscle');

    expect(namesIn(returningSection()).filter((name) => !isKnownName(name))).toEqual([]);
  });
});
