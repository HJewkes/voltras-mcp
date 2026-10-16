// The `messy` persona's odd rows: every shape a real store collects that the
// read paths have to filter. A set with no exercise, an auto-armed set, a
// partial, warm-up, probe and technique sets, a guest's session, sessions
// nobody reviewed, a test session, and one session left open with its last
// rep seven hours old.

import type { StoredSession, StoredSet } from '../../store/types.js';
import { localAt, localMonday } from './calendar.js';
import { performSet, type LifterParams } from './fatigue.js';
import { lifterAt } from './lifts.js';
import type { Rng } from './rng.js';
import { setRow } from './sets.js';
import type { PersonaExtrasReport, PersonaLift } from './types.js';
import type { PersonaStore } from './write.js';

const HOUR_MS = 3_600_000;
const SET_GAP_MS = 4 * 60_000;

/** A plain working set's fields to change; `noExercise` writes the set with no exercise. */
type OddSet = Partial<StoredSet> & { readonly noExercise?: true };

/** One odd session: the session row, then each set as a tweak of a plain working set. */
interface OddSession {
  readonly id: string;
  readonly startedAt: Date;
  readonly session?: Partial<StoredSession>;
  readonly sets: readonly OddSet[];
  /** Left open: no end written. */
  readonly open?: boolean;
}

const ODD_SET_REPS = 8;

/** `velocityLossPct` is how hard each odd set is taken, as the persona's training takes its own. */
export function messyExtras(lift: PersonaLift, velocityLossPct: number) {
  const lifter = lifterAt(lift.lifter, ODD_SET_REPS, velocityLossPct);
  return async (store: PersonaStore, now: Date, rng: Rng): Promise<PersonaExtrasReport> => {
    let sets = 0;
    const sessions = oddSessions(now);
    for (const odd of sessions) sets += await seedOddSession(store, odd, { lift, lifter }, rng);
    return { sessions: sessions.length, sets, goals: 0 };
  };
}

function oddSessions(now: Date): OddSession[] {
  const lastWeek = localMonday(now, 1);
  return [
    {
      id: 'messy-odd-purposes',
      startedAt: localAt(lastWeek, 2, 12),
      session: { kind: 'training' },
      sets: [
        { setPurpose: 'warmup' },
        { setPurpose: 'probe' },
        { setPurpose: 'technique' },
        { noExercise: true },
        { autoCreatedBy: 'idle_rep' },
        { partial: true, partialReason: 'inactivity_timeout' },
      ],
    },
    {
      id: 'messy-guest',
      startedAt: localAt(lastWeek, 5, 10),
      session: { kind: 'training', lifter: 'Guest' },
      sets: [{ lifter: 'Guest' }, { lifter: 'Guest' }],
    },
    { id: 'messy-legacy-1', startedAt: localAt(localMonday(now, 6), 1, 19), sets: [{}, {}] },
    { id: 'messy-legacy-2', startedAt: localAt(localMonday(now, 7), 3, 19), sets: [{}] },
    {
      id: 'messy-test',
      startedAt: localAt(lastWeek, 6, 15),
      session: { kind: 'test' },
      sets: [{ source: 'mock' }, { source: 'mock' }],
    },
    {
      id: 'messy-open',
      startedAt: new Date(now.getTime() - 7 * HOUR_MS - 2 * SET_GAP_MS),
      session: { kind: 'training' },
      sets: [{}, {}],
      open: true,
    },
  ];
}

async function seedOddSession(
  store: PersonaStore,
  odd: OddSession,
  { lift, lifter }: { lift: PersonaLift; lifter: LifterParams },
  rng: Rng,
): Promise<number> {
  const rows = odd.sets.map((tweak, order) => {
    const startMs = odd.startedAt.getTime() + order * SET_GAP_MS;
    const plain = setRow(
      { sessionId: odd.id, lift, loadLbs: lift.startLoadLbs, startMs, order },
      freshSet(lifter, rng),
    );
    return withTweak(plain, tweak);
  });
  await store.putSession({
    id: odd.id,
    startedAt: odd.startedAt.toISOString(),
    ...(odd.open === true ? {} : { endedAt: rows.at(-1)?.endedAt ?? odd.startedAt.toISOString() }),
    exerciseId: lift.exerciseId,
    exerciseName: lift.name,
    ...odd.session,
  });
  for (const row of rows) await store.putSet(row);
  return rows.length;
}

function withTweak(plain: StoredSet, { noExercise, ...tweak }: OddSet): StoredSet {
  const row: StoredSet = { ...plain, ...tweak };
  if (noExercise === true) delete row.exerciseId;
  return row;
}

function freshSet(lifter: LifterParams, rng: Rng): readonly number[] {
  return performSet(lifter, 0, { targetReps: ODD_SET_REPS }, rng).velocities;
}
