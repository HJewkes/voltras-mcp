import { setCatalog } from '@voltras/workout-analytics';

import { HISTORY_SEED_EXERCISES } from '../history-seed-catalog.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

/** Loads the catalog the server loads at boot, for tests that derive ramp classes. */
export function loadSeedCatalog(): void {
  setCatalog([...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES]);
}
