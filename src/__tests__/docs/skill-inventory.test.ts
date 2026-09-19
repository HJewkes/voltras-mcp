// The coach skill's tool inventory is generated so it cannot drift from the
// registry (VW-503). `tool-reference.test.ts` proves the committed page is the
// one this renderer produces; these are the rules the renderer itself applies,
// on fixtures small enough to read.

import { describe, expect, it } from 'vitest';

import { renderSkillInventory, type SkillInventoryInput } from '../../docs/skill-inventory.js';
import { SKILL_TOOL_JOBS, SKILL_TOOL_NOTES } from '../../docs/skill-inventory-notes.js';
import { CORE_TOOL_NAMES, TOOL_ACCESS } from '../../tool-registry.js';

const JOBS = [{ id: 'connect', heading: 'Find and connect the device' }] as const;

function input(overrides: Partial<SkillInventoryInput> = {}): SkillInventoryInput {
  return {
    coreToolNames: ['device.scan', 'device.get_state'],
    mockToolNames: ['mock.configure'],
    access: { 'device.scan': 'write', 'device.get_state': 'read' },
    notes: {
      'device.scan': { job: 'connect', when: 'Start of every workout', rule: 'Scan again' },
      'device.get_state': { job: 'connect', when: 'After every setter', rule: 'The only proof' },
    },
    jobs: JOBS,
    verifiedLine: 'Verified never',
    ...overrides,
  };
}

describe('the access letter', () => {
  it('reads W for a tool that drives the device or the store', () => {
    expect(renderSkillInventory(input())).toContain('| `device.scan` | W |');
  });

  it('reads R for a read', () => {
    expect(renderSkillInventory(input())).toContain('| `device.get_state` | R |');
  });

  it('reads D alone for a read diagnostic, because D already says read-only', () => {
    const notes = {
      ...input().notes,
      'device.get_state': {
        job: 'connect',
        when: 'After every setter',
        rule: 'The only proof',
        diagnostic: true,
      },
    } as SkillInventoryInput['notes'];
    expect(renderSkillInventory(input({ notes }))).toContain('| `device.get_state` | D |');
  });

  it('reads W D for a diagnostic that also writes', () => {
    const notes = {
      ...input().notes,
      'device.scan': {
        job: 'connect',
        when: 'Start of every workout',
        rule: 'Scan again',
        diagnostic: true,
      },
    } as SkillInventoryInput['notes'];
    expect(renderSkillInventory(input({ notes }))).toContain('| `device.scan` | W D |');
  });
});

describe('what the renderer refuses to publish', () => {
  it('refuses a registered tool with no note, so a new tool cannot go unlisted', () => {
    const missing = input({ coreToolNames: ['device.scan', 'device.get_state', 'device.unload'] });
    expect(() => renderSkillInventory(missing)).toThrow(/device.unload/);
  });

  it('refuses a note for a tool the registry does not have', () => {
    const extra = input({ coreToolNames: ['device.scan'] });
    expect(() => renderSkillInventory(extra)).toThrow(/device.get_state/);
  });

  it('refuses a note filed under a section the page does not have', () => {
    const notes = {
      ...input().notes,
      'device.scan': { job: 'load', when: 'Start', rule: 'Scan again' },
    } as SkillInventoryInput['notes'];
    expect(() => renderSkillInventory(input({ notes }))).toThrow(/filed under no section/);
  });

  it('refuses a section no tool is filed under', () => {
    const jobs = [...JOBS, { id: 'debug', heading: 'Debug' }] as SkillInventoryInput['jobs'];
    expect(() => renderSkillInventory(input({ jobs }))).toThrow(/"debug"/);
  });
});

describe('counts on the page', () => {
  it('derives the tool and namespace counts rather than stating a literal', () => {
    expect(renderSkillInventory(input())).toContain('**2 tools in 1 namespaces**');
  });
});

// The shipped data, not a fixture: the exhaustive `Record<CoreToolName, …>`
// makes a missing note a tsc error, and this catches the inverse plus the two
// lists agreeing on what a section is.
describe('the shipped notes', () => {
  it('covers the whole registry and nothing else', () => {
    expect(Object.keys(SKILL_TOOL_NOTES).sort()).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it('files every tool under a section the page renders', () => {
    const sections = new Set(SKILL_TOOL_JOBS.map((job) => job.id));
    const orphans = Object.entries(SKILL_TOOL_NOTES)
      .filter(([, note]) => !sections.has(note.job))
      .map(([name]) => name);
    expect(orphans).toEqual([]);
  });

  it('classifies every noted tool in TOOL_ACCESS', () => {
    const unclassified = Object.keys(SKILL_TOOL_NOTES).filter(
      (name) => TOOL_ACCESS[name as keyof typeof TOOL_ACCESS] === undefined,
    );
    expect(unclassified).toEqual([]);
  });
});
