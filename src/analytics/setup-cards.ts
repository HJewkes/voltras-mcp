// The declared setup card (VW-275) — anchor landmark, mount hole, cable-length
// setting, and mode — as distinct from the ROM-INFERRED setup clustering in
// `store/exercise-setups.ts`. A card is only ever written by a human through
// `exercise.confirm_setup`; nothing here infers one.
//
// WHY A SECOND CONCEPT, NOT A REPLACEMENT
// ----------------------------------------
// The ROM cluster answers "did the cable travel the same distance as last
// time" without knowing why. A card answers what the rig was actually SET TO.
// The two agree in the common case (same bench, same cable length -> same
// travel) but diverge exactly when they are most useful apart: a lifter who
// nudges the mount hole without changing stance produces the same ROM but a
// different card, and the geometry gate in `setup-comparability.ts` (VW-272)
// would pass a pair the card correctly flags.
//
// THE EXERCISE'S REFERENCE CARD
// ------------------------------
// `getReferenceSetupCard` prefers the most recently confirmed card for
// (userId, exerciseId) — any side, since anchor/mount/mode are properties of
// the rig, not the limb. Absent a confirmed one, it falls back to
// {@link seededReferenceCard}, seeded as DATA from the layout research digest's
// per-exercise-family setup table (voltras-workspace initiative, 2026-09-13) so
// the wall has something to show and comparability something to gate on
// before anyone has confirmed a setup at all. A confirmed card always wins.
//
// Numeric anchor heights stay UNVERIFIED per the digest (no vendor publishes
// one) — `SetupCardAnchor` is a landmark ('low'/'mid'/'chest'/'high'), never a
// measurement, and nothing in this file invents one.

import type {
  ExerciseSetupFilter,
  SetupCard,
  SetupCardAnchor,
  StoredExerciseSetup,
} from '../store/types.js';

/** What {@link compareSetupCards} may answer. Mirrors `SetupComparability`'s shape (VW-272). */
export type SetupCardComparability = 'comparable' | 'setup_card_mismatch' | 'setup_card_unverified';

/** The gate's answer: a verdict, why, and both cards it read. */
export interface SetupCardComparabilityVerdict {
  comparability: SetupCardComparability;
  reason: string;
  session?: SetupCard;
  reference?: SetupCard;
}

/**
 * May a session's declared card be read against the exercise's reference
 * card? DEGRADE, NEVER REFUSE SILENTLY, the same posture as
 * `compareSetupSignatures`: a missing card on either side is `setup_card_unverified`
 * (the check never ran), never treated as a match or a mismatch.
 */
export function compareSetupCards(
  session: SetupCard | undefined,
  reference: SetupCard | undefined,
): SetupCardComparabilityVerdict {
  if (session === undefined || reference === undefined) {
    return {
      comparability: 'setup_card_unverified',
      reason:
        `no ${missingSide(session, reference)} setup card is recorded, so the card gate ` +
        'could not run; a session that has not confirmed one has not been checked against the reference',
      ...(session !== undefined ? { session } : {}),
      ...(reference !== undefined ? { reference } : {}),
    };
  }
  const differing = differingFields(session, reference);
  if (differing.length > 0) {
    return {
      comparability: 'setup_card_mismatch',
      reason: `the session's card differs from the exercise's reference card on ${differing.join(', ')}`,
      session,
      reference,
    };
  }
  return {
    comparability: 'comparable',
    reason: "the session's card matches the exercise's reference card",
    session,
    reference,
  };
}

/**
 * Fields present on BOTH cards that disagree. A field named on only one side
 * carries no evidence either way — the reference may predate mount-hole
 * recording, say — so it is never counted as a difference.
 */
function differingFields(session: SetupCard, reference: SetupCard): string[] {
  const out: string[] = [];
  if (session.anchor !== reference.anchor) out.push('anchor');
  if (
    session.mountHole !== undefined &&
    reference.mountHole !== undefined &&
    session.mountHole !== reference.mountHole
  ) {
    out.push('mountHole');
  }
  if (
    session.cableLengthSetting !== undefined &&
    reference.cableLengthSetting !== undefined &&
    String(session.cableLengthSetting) !== String(reference.cableLengthSetting)
  ) {
    out.push('cableLengthSetting');
  }
  if (
    session.mode !== undefined &&
    reference.mode !== undefined &&
    session.mode !== reference.mode
  ) {
    out.push('mode');
  }
  return out;
}

function missingSide(session: SetupCard | undefined, reference: SetupCard | undefined): string {
  if (session === undefined && reference === undefined) return 'session or reference';
  return session === undefined ? 'session' : 'reference';
}

/**
 * Per-family anchor defaults seeded from the layout digest's per-family table.
 * Keyed by the catalog's own `cableSetup.cablePath` — the only per-exercise
 * geometry field the catalog already carries — because the digest's ten
 * families reduce to the same four landmarks the setup card uses. `'floor'`
 * (leg isolation, hip hinge) has no distinct value in {@link SetupCardAnchor}
 * and buckets into `'low'`, the nearest landmark. `'multiple'` (barbell/Twin
 * patterns, digest row 10) has no single reference anchor and is intentionally
 * unmapped — those exercises get no seeded default.
 */
const CABLE_PATH_ANCHOR: Partial<Record<string, SetupCardAnchor>> = {
  low: 'low',
  mid: 'mid',
  high: 'high',
  floor: 'low',
};

/**
 * The digest-seeded default for an exercise with no confirmed setup yet.
 * Anchor only — mount hole and cable-length setting are rig-specific with no
 * vendor default, and the digest does not prescribe a resistance mode per
 * family (Twin Mode for barbell patterns is the one exception, and those
 * exercises fall under `cablePath: 'multiple'`, which is unmapped above).
 */
export function seededReferenceCard(exercise: CableSetupSource): SetupCard | undefined {
  const cablePath = exercise.cableSetup?.cablePath;
  if (cablePath === undefined) return undefined;
  const anchor = CABLE_PATH_ANCHOR[cablePath];
  return anchor === undefined ? undefined : { anchor };
}

/**
 * The minimal shape {@link seededReferenceCard} reads — `Exercise`'s `cablePath`
 * only, not the rest of `cableSetup` — so callers with a narrower catalog view
 * (the dashboard's, which drops `attachments`/`notes`) can still supply one.
 */
export interface CableSetupSource {
  cableSetup?: { cablePath: string };
}

/** The slice of the store `getReferenceSetupCard` needs. */
export interface ReferenceSetupCardStore {
  listExerciseSetups(filter: ExerciseSetupFilter): Promise<StoredExerciseSetup[]>;
}

/** The slice of the exercise catalog `getReferenceSetupCard` needs. */
export interface ReferenceSetupCardCatalog {
  getById(id: string): CableSetupSource | undefined;
}

/**
 * The exercise's reference card: the most recently confirmed card for
 * (userId, exerciseId) across every side, or the digest-seeded default when
 * none has been confirmed yet. `undefined` when neither exists.
 */
export async function getReferenceSetupCard(
  store: ReferenceSetupCardStore,
  catalog: ReferenceSetupCardCatalog,
  key: ExerciseSetupFilter,
): Promise<SetupCard | undefined> {
  const confirmed = (await store.listExerciseSetups(key))
    .filter(
      (setup): setup is StoredExerciseSetup & { confirmedAt: string; card: SetupCard } =>
        setup.confirmedAt !== undefined && setup.card !== undefined,
    )
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
  if (confirmed.length > 0) return confirmed[0].card;
  const exercise = catalog.getById(key.exerciseId);
  return exercise === undefined ? undefined : seededReferenceCard(exercise);
}
