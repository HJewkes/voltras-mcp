import { describe, expect, it } from 'vitest';

import { nodeFloorProblem } from '../node-floor.js';

describe('nodeFloorProblem', () => {
  it('refuses Node 22.12.0 with a message naming 22.13', () => {
    expect(nodeFloorProblem('22.12.0')).toContain('Node 22.13 or later');
  });

  it('refuses an older major', () => {
    expect(nodeFloorProblem('20.19.0')).toContain('Node 22.13 or later');
  });

  it('accepts Node 22.13.0, the first release with node:sqlite unflagged', () => {
    expect(nodeFloorProblem('22.13.0')).toBeNull();
  });

  it('accepts a newer major', () => {
    expect(nodeFloorProblem('24.1.0')).toBeNull();
  });
});
