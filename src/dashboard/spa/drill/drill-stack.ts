/**
 * The dashboard shell's drill stack (VW-339): which side-sheets are open over a page, bottom
 * first. Pure, so the cap and lineage rules are asserted rather than clicked.
 *
 * Rules, from the drill-down overlay model:
 *   - Opening a surface from a lineage already on the stack replaces that layer and drops
 *     anything above it, so one object graph never stacks on itself.
 *   - A new lineage pushes, up to {@link DRILL_STACK_CAP} layers.
 *   - At the cap, a new lineage re-bases the top layer instead of pushing a third.
 *   - `close` pops one layer; `reset` (the idle heal) clears the stack in one step.
 */

/** The most layers the stack ever holds: a sheet and one lateral peek. */
export const DRILL_STACK_CAP = 2;

/** One open surface: its object lineage (e.g. `muscle`) and the object it shows. */
export interface DrillLayer {
  lineage: string;
  id: string;
}

export type DrillStack = readonly DrillLayer[];

export type DrillAction =
  | { type: 'open'; layer: DrillLayer }
  | { type: 'close' }
  | { type: 'reset' };

export const EMPTY_DRILL_STACK: DrillStack = [];

export function drillStackReducer(stack: DrillStack, action: DrillAction): DrillStack {
  switch (action.type) {
    case 'open':
      return openLayer(stack, action.layer);
    case 'close':
      return stack.length === 0 ? stack : stack.slice(0, -1);
    case 'reset':
      return stack.length === 0 ? stack : EMPTY_DRILL_STACK;
  }
}

function openLayer(stack: DrillStack, layer: DrillLayer): DrillStack {
  const sameLineage = stack.findIndex((open) => open.lineage === layer.lineage);
  if (sameLineage !== -1) return [...stack.slice(0, sameLineage), layer];
  if (stack.length < DRILL_STACK_CAP) return [...stack, layer];
  return [...stack.slice(0, DRILL_STACK_CAP - 1), layer];
}

/** The surface on top, which Escape and a layer's own dismiss close. */
export function topLayer(stack: DrillStack): DrillLayer | null {
  return stack.at(-1) ?? null;
}
