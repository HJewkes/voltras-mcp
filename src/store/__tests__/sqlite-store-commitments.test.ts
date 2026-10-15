// The commitments store (VW-505): append-only per revision, verbatim text, and a timeline
// that stays sound whatever order the weeks arrive in.
//
// Every fixture is synthetic. The wording is invented for these tests and is nobody's.

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID, type DeclareCommitmentInput } from '../types.js';
import { openSqliteTestStore } from './open-test-store.js';

const WEEK_ONE = '2026-09-21';
const WEEK_TWO = '2026-09-28';
const AT = '2026-09-20T18:00:00.000Z';

let store: SqliteSessionStore;

function declaration(overrides: Partial<DeclareCommitmentInput> = {}): DeclareCommitmentInput {
  return {
    userId: LOCAL_USER_ID,
    effectiveFrom: WEEK_ONE,
    days: [
      { day: 'Monday', fallbackDay: 'Tuesday' },
      { day: 'Wednesday', fallbackDay: 'Thursday' },
      { day: 'Friday', fallbackDay: 'Saturday' },
    ],
    ifThen: 'If the 6pm meeting runs long, then Wednesday moves to Thursday.',
    wording: 'Three lifts a week, no excuses about the drive.',
    declaredAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  store = openSqliteTestStore();
});

afterEach(() => {
  store.close();
});

describe('declaring a commitment', () => {
  it('stores the four answers and reads them back verbatim, spacing included', async () => {
    const input = declaration({
      ifThen: '  If Monday goes, then Tuesday takes it.  ',
      wording: '"Three a week." Nothing more.',
    });

    await store.declareCommitment(input);
    const read = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);

    expect(read?.ifThen).toBe('  If Monday goes, then Tuesday takes it.  ');
    expect(read?.wording).toBe('"Three a week." Nothing more.');
    expect(read?.days).toEqual(input.days);
    expect(read?.revision).toBe(1);
  });

  it('writes sessions_per_week as the length of the day list', async () => {
    await store.declareCommitment(declaration());

    const read = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);

    expect(read?.sessionsPerWeek).toBe(3);
  });

  it('reads nothing for a week before the first commitment', async () => {
    await store.declareCommitment(declaration({ effectiveFrom: WEEK_TWO }));

    expect(await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE)).toBeUndefined();
  });

  it('stands until the next declaration supersedes it', async () => {
    await store.declareCommitment(declaration());

    const laterWeek = await store.getCommitmentForWeek(LOCAL_USER_ID, '2026-10-19');

    expect(laterWeek?.effectiveFrom).toBe(WEEK_ONE);
  });
});

describe('correcting a week', () => {
  it('appends the next revision and keeps the superseded wording', async () => {
    await store.declareCommitment(declaration());
    const corrected = await store.declareCommitment(
      declaration({ wording: 'Three a week, and Saturday is not one of them.' }),
    );

    const rows = allRows();
    expect(corrected.commitment.revision).toBe(2);
    expect(corrected.unchanged).toBe(false);
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(rows[0].lifter_wording).toBe('Three lifts a week, no excuses about the drive.');
  });

  it('reads the greatest revision of the week', async () => {
    await store.declareCommitment(declaration());
    await store.declareCommitment(declaration({ ifThen: 'If Friday goes, then Sunday takes it.' }));

    const read = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);

    expect(read?.revision).toBe(2);
    expect(read?.ifThen).toBe('If Friday goes, then Sunday takes it.');
  });

  it('treats a changed fallback day as a correction, not a repeat', async () => {
    await store.declareCommitment(declaration());
    const moved = await store.declareCommitment(
      declaration({
        days: [
          { day: 'Monday', fallbackDay: 'Friday' },
          { day: 'Wednesday', fallbackDay: 'Thursday' },
          { day: 'Friday', fallbackDay: 'Saturday' },
        ],
      }),
    );

    expect(moved.unchanged).toBe(false);
    expect(moved.commitment.revision).toBe(2);
    expect(moved.commitment.days[0]).toEqual({ day: 'Monday', fallbackDay: 'Friday' });
  });

  it('treats a reordered day list as a correction, not a repeat', async () => {
    await store.declareCommitment(declaration());
    const reordered = await store.declareCommitment(
      declaration({
        days: [
          { day: 'Wednesday', fallbackDay: 'Thursday' },
          { day: 'Monday', fallbackDay: 'Tuesday' },
          { day: 'Friday', fallbackDay: 'Saturday' },
        ],
      }),
    );

    expect(reordered.unchanged).toBe(false);
    expect(reordered.commitment.revision).toBe(2);
  });
});

describe('an identical declaration', () => {
  it('writes nothing, keeps the revision and says nothing changed', async () => {
    await store.declareCommitment(declaration());
    const retried = await store.declareCommitment(
      declaration({ declaredAt: '2026-09-20T19:00:00.000Z' }),
    );

    expect(retried.unchanged).toBe(true);
    expect(retried.commitment.revision).toBe(1);
    expect(retried.commitment.declaredAt).toBe(AT);
    expect(allRows()).toHaveLength(1);
  });
});

describe('the timeline across weeks', () => {
  it('closes each week at the next committed Monday', async () => {
    await store.declareCommitment(declaration());
    await store.declareCommitment(declaration({ effectiveFrom: WEEK_TWO }));

    const first = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);
    const second = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_TWO);

    expect(first?.effectiveTo).toBe(WEEK_TWO);
    expect(second?.effectiveTo).toBeNull();
  });

  it('stays sound when an earlier week is committed to after a later one', async () => {
    await store.declareCommitment(declaration({ effectiveFrom: WEEK_TWO }));
    await store.declareCommitment(declaration({ effectiveFrom: WEEK_ONE }));

    const first = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);
    const second = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK_TWO);

    expect(first?.effectiveTo).toBe(WEEK_TWO);
    expect(second?.effectiveTo).toBeNull();
  });

  it('gives every revision of a week the same closing date', async () => {
    await store.declareCommitment(declaration());
    await store.declareCommitment(declaration({ effectiveFrom: WEEK_TWO }));
    await store.declareCommitment(declaration({ wording: 'Three a week, Fridays included.' }));

    expect(allRows().map((row) => [row.effective_from, row.effective_to])).toEqual([
      [WEEK_ONE, WEEK_TWO],
      [WEEK_ONE, WEEK_TWO],
      [WEEK_TWO, null],
    ]);
  });
});

describe('the append-only guarantee', () => {
  it('refuses an UPDATE of the lifter’s own words', async () => {
    await store.declareCommitment(declaration());

    expect(() => rawDb().exec(`UPDATE commitments SET lifter_wording = 'not mine'`)).toThrow(
      /append-only/,
    );
  });

  it('refuses a DELETE, so a superseded revision cannot be dropped', async () => {
    await store.declareCommitment(declaration());
    await store.declareCommitment(declaration({ wording: 'Three a week, Fridays included.' }));

    expect(() => rawDb().exec('DELETE FROM commitments')).toThrow(/never deleted/);
    expect(allRows()).toHaveLength(2);
  });

  it('refuses a second row at the same revision of the same week', async () => {
    await store.declareCommitment(declaration());

    expect(() =>
      rawDb().exec(
        `INSERT INTO commitments
           (id, user_id, effective_from, sessions_per_week, days_json, declared_at, revision)
         VALUES ('dupe', '${LOCAL_USER_ID}', '${WEEK_ONE}', 3, '[]', '${AT}', 1)`,
      ),
    ).toThrow(/UNIQUE/i);
  });
});

interface RawRow {
  effective_from: string;
  effective_to: string | null;
  revision: number;
  lifter_wording: string | null;
}

/** The store's own handle: `:memory:` rows are invisible to a second connection. */
function rawDb(): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function allRows(): RawRow[] {
  return rawDb()
    .prepare(`SELECT * FROM commitments ORDER BY effective_from ASC, revision ASC`)
    .all() as unknown as RawRow[];
}
