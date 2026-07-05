/**
 * Weekly volume-status panel (VMCP-01.54).
 *
 * A compact "which muscles are under/over this week" summary: the same
 * `/api/muscle-volume` weekly data the BodyMap heatmap paints, surfaced as titan
 * `MuscleGroupChip`s (dot color = MEV/MAV/MRV landmark status). Complements the
 * heatmap — a scannable list vs the anatomical view — using data already
 * computed, so it adds no new server signal.
 *
 * Like `BodyMapPanel`, `buildVolumeStatusChips` (via `../bodymap`) pulls titan's
 * `/bodymap` subpath + react-native-body-highlighter, so this panel is loaded
 * lazily to keep that dependency out of the main SPA chunk (VMCP-01.57).
 */
import { useMemo } from 'react';
import { MuscleGroupChip } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import { buildVolumeStatusChips } from '../bodymap';

export function VolumeStatusPanel({
  weeklySetsByMuscle,
}: {
  /** Effective sets per voltras muscle over the trailing week. */
  weeklySetsByMuscle: Record<string, number>;
}): React.JSX.Element {
  const chips = useMemo(() => buildVolumeStatusChips(weeklySetsByMuscle), [weeklySetsByMuscle]);

  return (
    <PanelCard title="Weekly volume status">
      {chips.length === 0 ? (
        <p className="panel-empty">No training logged this week.</p>
      ) : (
        <div className="volume-status-chips">
          {chips.map((chip) => (
            <MuscleGroupChip
              key={chip.muscleGroup}
              name={`${chip.name} · ${chip.weeklySets}`}
              volumeStatus={chip.status}
            />
          ))}
        </div>
      )}
    </PanelCard>
  );
}
