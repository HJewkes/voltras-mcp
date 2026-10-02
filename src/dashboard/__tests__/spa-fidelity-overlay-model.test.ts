// The fidelity overlay's pure model (VW-798, VW-431 S3): rect grouping, label merging,
// legend rows, the promotion list and the toggle inputs.

import { describe, expect, it } from 'vitest';

import {
  groupOutlines,
  initialEnabled,
  isToggleShortcut,
  legendRows,
  overlayReport,
  promotionCandidates,
  type MeasuredEntry,
} from '../spa/dev/fidelity/overlay-model.js';
import type { FidelityEntry, FidelitySnapshot } from '../spa/dev/fidelity/registry.js';

const GOALS = 'src/dashboard/spa/goals/GoalsView.tsx';
const PLANNER = 'src/dashboard/spa/planner/PanelCard.tsx';

function entry(id: string, kind: FidelityEntry['kind'], name: string, source = GOALS) {
  return { id, kind, name, source };
}

function at(item: FidelityEntry, x: number, y: number, width = 100, height = 40): MeasuredEntry {
  return { entry: item, rect: { x, y, width, height } };
}

function snapshotOf(entries: readonly FidelityEntry[]): FidelitySnapshot {
  const summarize = (kind: FidelityEntry['kind']) => {
    const ofKind = entries.filter((item) => item.kind === kind);
    return { instances: ofKind.length, names: [...new Set(ofKind.map((i) => i.name))].sort() };
  };
  return {
    entries,
    kinds: {
      titan: summarize('titan'),
      spa: summarize('spa'),
      placeholder: summarize('placeholder'),
    },
  };
}

describe('groupOutlines', () => {
  it('merges box-less wrappers that share a rect into one stacked label, outermost first', () => {
    const groups = groupOutlines([
      at(entry('a', 'spa', 'GoalsView'), 0, 0),
      at(entry('b', 'spa', 'PerLiftGrid'), 0, 0),
      at(entry('c', 'titan', 'Surface'), 0.4, 0.2),
      at(entry('d', 'titan', 'Caption'), 10, 50, 60, 12),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      label: 'GoalsView > PerLiftGrid > Surface',
      kind: 'titan',
      dashed: false,
      tagged: true,
      rect: { x: 0, y: 0, width: 100, height: 40 },
    });
    expect(groups[1]).toMatchObject({ label: 'Caption', kind: 'titan' });
  });

  it('skips entries that render nothing visible', () => {
    const groups = groupOutlines([
      at(entry('a', 'spa', 'Hidden'), 0, 0, 0, 0),
      at(entry('b', 'spa', 'Flat'), 5, 5, 100, 0),
    ]);

    expect(groups).toEqual([]);
  });

  it('dashes a group with a placeholder and leaves an icon-only group untagged', () => {
    const groups = groupOutlines([
      at(entry('a', 'placeholder', 'EmptyStrip'), 0, 0),
      at(entry('b', 'titan', 'Surface'), 0, 0),
      at(entry('c', 'titan', 'DumbbellIcon'), 200, 0, 16, 16),
    ]);

    expect(groups[0]).toMatchObject({ label: 'EmptyStrip > Surface', dashed: true });
    expect(groups[1]).toMatchObject({ label: 'DumbbellIcon', tagged: false });
  });
});

describe('legendRows', () => {
  it('shows live counts and distinct names per kind, with icons collapsed', () => {
    const rows = legendRows(
      snapshotOf([
        entry('a', 'titan', 'Surface'),
        entry('b', 'titan', 'Surface'),
        entry('c', 'titan', 'DumbbellIcon'),
        entry('d', 'titan', 'LayersIcon'),
        entry('e', 'spa', 'PanelCard', PLANNER),
      ]),
    );

    expect(rows).toEqual([
      {
        kind: 'titan',
        title: 'titan',
        instances: 4,
        distinctNames: 3,
        names: ['Surface'],
        iconNames: ['DumbbellIcon', 'LayersIcon'],
      },
      {
        kind: 'spa',
        title: 'SPA-local',
        instances: 1,
        distinctNames: 1,
        names: ['PanelCard'],
        iconNames: [],
      },
      {
        kind: 'placeholder',
        title: 'placeholder',
        instances: 0,
        distinctNames: 0,
        names: [],
        iconNames: [],
      },
    ]);
  });

  it('does not treat an SPA-local component ending in Icon as a titan icon', () => {
    const [, spa] = legendRows(snapshotOf([entry('a', 'spa', 'StatusIcon')]));

    expect(spa).toMatchObject({ names: ['StatusIcon'], iconNames: [] });
  });
});

describe('promotionCandidates and the JSON report', () => {
  const current = snapshotOf([
    entry('a', 'spa', 'PanelCard', PLANNER),
    entry('b', 'spa', 'PanelCard', PLANNER),
    entry('c', 'spa', 'GoalsView'),
    entry('d', 'titan', 'Surface', '@titan-design/react-ui'),
  ]);

  it('lists each SPA-local component once with its source file and instance count', () => {
    expect(promotionCandidates(current)).toEqual([
      { name: 'GoalsView', source: GOALS, instances: 1 },
      { name: 'PanelCard', source: PLANNER, instances: 2 },
    ]);
  });

  it('carries the kinds, the candidates and the uninstrumented list', () => {
    const report = overlayReport(current, [{ name: 'StatRow', source: GOALS }]);

    expect(report.kinds.spa.instances).toBe(3);
    expect(report.promotionCandidates).toHaveLength(2);
    expect(report.uninstrumented).toEqual([{ name: 'StatRow', source: GOALS }]);
  });
});

describe('toggle inputs', () => {
  it('defaults off, follows the tab, and lets the URL win', () => {
    expect(initialEnabled('', null)).toBe(false);
    expect(initialEnabled('', '1')).toBe(true);
    expect(initialEnabled('?fidelity=1', '0')).toBe(true);
    expect(initialEnabled('?fidelity=0', '1')).toBe(false);
  });

  it('matches Alt+Shift+F on the physical key only', () => {
    expect(isToggleShortcut({ altKey: true, shiftKey: true, code: 'KeyF' })).toBe(true);
    expect(isToggleShortcut({ altKey: true, shiftKey: false, code: 'KeyF' })).toBe(false);
    expect(isToggleShortcut({ altKey: false, shiftKey: true, code: 'KeyF' })).toBe(false);
  });
});
