// The `goal-mix` persona: every goal status on one page. Three lifts take the
// preview seed's own histories for behind, on track and ahead (`GOAL_PREVIEW_STATES`),
// beside the preview's cut with its bodyweight goal and 28-day session goal.

import {
  GOAL_PREVIEW_STATES,
  seedLift,
  seedWholeBody,
  type GoalPreviewStateName,
  type SeededLift,
} from '../preview-seeds.js';
import type { StoredPriorityLevel } from '../../store/types.js';
import type { PersonaExtrasReport } from './types.js';
import type { PersonaStore } from './write.js';

const LIFTS: readonly {
  state: GoalPreviewStateName;
  id: string;
  name: string;
  level: StoredPriorityLevel;
}[] = [
  { state: 'on_track', id: 'cable-chest-press', name: 'Cable Chest Press', level: 'specialize' },
  { state: 'behind', id: 'cable-lat-pulldown', name: 'Cable Lat Pulldown', level: 'maintain' },
  { state: 'ahead', id: 'cable-row', name: 'Cable Row', level: 'maintain' },
];

function previewLift(entry: (typeof LIFTS)[number], index: number): SeededLift {
  const history = GOAL_PREVIEW_STATES.find((state) => state.name === entry.state);
  if (history === undefined) throw new Error(`no goal preview state ${entry.state}`);
  return {
    key: `goal-mix-${entry.state}`,
    exercise: { id: entry.id, name: entry.name },
    level: entry.level,
    // Declared a day apart, so the list order is stable.
    declaredDaysAgo: 28 + index,
    history,
  };
}

export async function seedGoalMix(store: PersonaStore, now: Date): Promise<PersonaExtrasReport> {
  let sessions = 0;
  let sets = 0;
  for (const [index, entry] of LIFTS.entries()) {
    const seeded = await seedLift(store, previewLift(entry, index), now);
    sessions += seeded.written.sessions;
    sets += seeded.written.sets;
  }
  const wholeBody = await seedWholeBody(store, now);
  return { sessions, sets, goals: LIFTS.length + wholeBody.length };
}
