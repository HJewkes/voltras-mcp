// Catalog-to-titan muscle map (VW-328, B1 of the body-map plan).
//
// The seed catalog's `muscleGroups` / `secondaryMuscleGroups` strings are
// coarse (e.g. `shoulders`, `back`, `core`) and predate titan's 15-group
// body-map taxonomy (`packages/ui/src/components/custom/Workout/muscleTaxonomy.ts`
// in titan-design, `MuscleGroup` enum). This module is the one place that
// translates between them, versioned so a re-classification is detectable in
// `sessions.catalog_version` rather than silently rewriting historical
// per-muscle rollups.

import { log } from '../logger.js';

/** Bump whenever a mapping row below or a row of `seed-attribution.ts` changes. Stamped onto every new session. */
export const MUSCLE_MAP_VERSION = '2026-09-26.1';

/**
 * The 15 titan body-map slugs (titan-design `MuscleGroup` enum,
 * `muscleTaxonomy.ts` lines 17-40 at `origin/main`). Copied rather than
 * imported: this repo does not depend on titan-design.
 */
export const TITAN_MUSCLE_GROUPS = [
  'chest',
  'front_delts',
  'side_delts',
  'triceps',
  'lats',
  'upper_back',
  'rear_delts',
  'biceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
  'obliques',
] as const;

export type TitanMuscleGroup = (typeof TITAN_MUSCLE_GROUPS)[number];

/**
 * Every coarse string the seed catalog uses (`primary`/`secondary`), mapped to
 * the titan slug(s) it corresponds to. A row commented "no dedicated slug"
 * picks the nearest anatomical proxy because the taxonomy has nothing closer.
 */
const CATALOG_TO_TITAN: Record<string, TitanMuscleGroup[]> = {
  chest: ['chest'],
  // Data can't distinguish which head(s) of the deltoid a "shoulders" entry
  // trains, so all three combined-deltoid slugs are returned.
  shoulders: ['front_delts', 'side_delts', 'rear_delts'],
  triceps: ['triceps'],
  back: ['lats', 'upper_back'],
  biceps: ['biceps'],
  forearms: ['forearms'],
  quads: ['quads'],
  hamstrings: ['hamstrings'],
  glutes: ['glutes'],
  // No dedicated adductor slug in the taxonomy; quads is the nearest leg proxy.
  adductors: ['quads'],
  // No dedicated abductor slug either; hip abduction is primarily glute
  // medius/minimus, so glutes is the nearest proxy.
  abductors: ['glutes'],
  obliques: ['obliques'],
  core: ['abs', 'obliques'],
  abs: ['abs'],
  // No dedicated traps slug; upper_back is the taxonomy's closest region.
  traps: ['upper_back'],
};

/**
 * The catalog strings whose row above is a nearest-anatomical PROXY: the
 * taxonomy has no slug for them, so the row says "closest region", not "same
 * muscle". Every other row is either an identity or a genuine composite
 * (`back`, `core`, `shoulders`), where the slugs really are the muscle.
 *
 * A rollup that only asks "does this train the region" may read the proxy rows
 * like any other. A claim ABOUT the muscle may not: a hip adduction is not
 * evidence a quad grew. {@link isProxyMapping} is what that second kind of
 * consumer calls (first one: `analytics/goal-metrics.ts`, VW-347).
 */
export const PROXY_CATALOG_MUSCLES: ReadonlySet<string> = new Set([
  'adductors',
  'abductors',
  'traps',
]);

/** True when {@link mapCatalogMuscle} reaches its slugs through a proxy row. */
export function isProxyMapping(catalogString: string): boolean {
  return PROXY_CATALOG_MUSCLES.has(catalogString);
}

const warnedUnknown = new Set<string>();

/**
 * Map one catalog muscle-group string to its titan slug(s). An unrecognised
 * string (not one the seed catalog currently uses) maps to `[]` and logs a
 * `warn` once per distinct string, rather than throwing.
 */
export function mapCatalogMuscle(catalogString: string): TitanMuscleGroup[] {
  const mapped = CATALOG_TO_TITAN[catalogString];
  if (mapped !== undefined) return mapped;

  if (!warnedUnknown.has(catalogString)) {
    warnedUnknown.add(catalogString);
    log.warn(`mapCatalogMuscle: unrecognised catalog muscle group "${catalogString}"`);
  }
  return [];
}
