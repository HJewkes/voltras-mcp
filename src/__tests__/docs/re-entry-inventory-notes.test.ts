// Nothing the lifter sees counts how long they were away. The pt-session
// inventory notes are the coach's per-tool orders, so no return note may ask for the count (VW-980).

import { describe, expect, it } from 'vitest';

import { SKILL_TOOL_NOTES } from '../../docs/skill-inventory-notes.js';

const RETURN_TOPIC = /re-?entry|return ?clearance|return window|after a break/i;
const DAY_COUNT = /days?[\s_-]*(since|away)|(say|state)\s+the\s+days|streak/i;

const returnNotes = Object.entries(SKILL_TOOL_NOTES)
  .map(([tool, note]) => ({ tool, text: `${note.when} ${note.rule}` }))
  .filter(({ text }) => RETURN_TOPIC.test(text));

describe('the inventory notes for return and re-entry tools', () => {
  it('covers the tools that read or hold a return', () => {
    expect(returnNotes.map(({ tool }) => tool)).toEqual(
      expect.arrayContaining([
        'session.start',
        'plan.next_workout',
        'plan.suggest_progression',
        'profile.set_training_background',
      ]),
    );
  });

  it('never count the gap or speak of a streak', () => {
    expect(returnNotes.filter(({ text }) => DAY_COUNT.test(text)).map(({ tool }) => tool)).toEqual(
      [],
    );
  });
});
