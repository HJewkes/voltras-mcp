import { describe, expect, it } from 'vitest';

import {
  DRILL_STACK_CAP,
  EMPTY_DRILL_STACK,
  drillStackReducer,
  topLayer,
  type DrillAction,
  type DrillStack,
} from '../drill-stack.js';

const lats = { lineage: 'muscle', id: 'lats' };
const quads = { lineage: 'muscle', id: 'quads' };
const row = { lineage: 'exercise', id: 'row' };
const setDetail = { lineage: 'set', id: 'set-1' };

const run = (actions: DrillAction[], from: DrillStack = EMPTY_DRILL_STACK): DrillStack =>
  actions.reduce(drillStackReducer, from);
const open = (layer: typeof lats): DrillAction => ({ type: 'open', layer });

describe('drill stack', () => {
  it('pushes the first layer onto an empty stack', () => {
    expect(run([open(lats)])).toEqual([lats]);
  });

  it('replaces the sheet when another muscle opens from the same lineage', () => {
    expect(run([open(lats), open(quads)])).toEqual([quads]);
  });

  it('pushes a second layer from a different lineage', () => {
    expect(run([open(lats), open(row)])).toEqual([lats, row]);
  });

  it('re-bases the top layer on a third open, so the stack stays at the cap', () => {
    const stack = run([open(lats), open(row), open(setDetail)]);

    expect(stack).toEqual([lats, setDetail]);
    expect(stack).toHaveLength(DRILL_STACK_CAP);
  });

  it('drops the peek when the sheet lineage opens again beneath it', () => {
    expect(run([open(lats), open(row), open(quads)])).toEqual([quads]);
  });

  it('pops only the top layer on close, leaving the one below untouched', () => {
    const stack = run([open(lats), open(row), { type: 'close' }]);

    expect(stack).toEqual([lats]);
    expect(topLayer(stack)).toBe(lats);
  });

  it('empties the stack in one step on reset', () => {
    expect(run([open(lats), open(row), { type: 'reset' }])).toEqual([]);
  });

  it('treats close and reset on an empty stack as no-ops', () => {
    expect(drillStackReducer(EMPTY_DRILL_STACK, { type: 'close' })).toBe(EMPTY_DRILL_STACK);
    expect(drillStackReducer(EMPTY_DRILL_STACK, { type: 'reset' })).toBe(EMPTY_DRILL_STACK);
    expect(topLayer(EMPTY_DRILL_STACK)).toBeNull();
  });

  it('never mutates the stack it was given', () => {
    const before: DrillStack = [lats];

    run([open(row), open(setDetail), { type: 'close' }], before);

    expect(before).toEqual([lats]);
  });
});
