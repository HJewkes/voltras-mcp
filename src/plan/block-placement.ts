// Where a dated block may sit (VW-474): the two rules every schedule write checks before it
// appends a row. No two live calendars overlap, across every non-archived program (I2), and
// within one program the block order agrees with the date order (I7).
//
// Pure: the caller loads the live blocks and passes the world as it WOULD be after the write,
// so a cascaded move is checked as one proposal rather than block by block.

import { addDays, isMonday } from './block-calendar.js';

export interface PlacedBlock {
  blockId: string;
  programId: string;
  orderIndex: number;
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface PlacementConflict {
  kind: 'overlap' | 'order';
  block: PlacedBlock;
  other: PlacedBlock;
}

function overlaps(a: PlacedBlock, b: PlacedBlock): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

function outOfOrder(a: PlacedBlock, b: PlacedBlock): boolean {
  if (a.programId !== b.programId || a.orderIndex === b.orderIndex) return false;
  return a.orderIndex < b.orderIndex !== a.startsOn < b.startsOn;
}

/** The first rule a proposed placement breaks, checking only pairs that involve a changed block. */
export function placementConflict(
  proposed: readonly PlacedBlock[],
  changedIds: ReadonlySet<string>,
): PlacementConflict | null {
  for (const block of proposed) {
    if (!changedIds.has(block.blockId)) continue;
    for (const other of proposed) {
      if (other.blockId === block.blockId) continue;
      if (overlaps(block, other)) return { kind: 'overlap', block, other };
      if (outOfOrder(block, other)) return { kind: 'order', block, other };
    }
  }
  return null;
}

/** The Mondays either side of a date that is not one, for an error that says which was meant. */
export function mondaysAround(date: string): { before: string; after: string } {
  let before = date;
  while (!isMonday(before)) before = addDays(before, -1);
  return { before, after: addDays(before, 7) };
}
