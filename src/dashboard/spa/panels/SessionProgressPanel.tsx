/**
 * Session-progress panel (VMCP-01.45).
 *
 * Titan `MetricGroup` of `Metric` tiles: exercise, sets, total reps, total
 * volume — computed from the completed-set accumulator (in-flight reps excluded,
 * legacy parity).
 */
import { Metric, MetricGroup } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import type { SessionProgressView } from '../adapter';

export function SessionProgressPanel({ view }: { view: SessionProgressView }): React.JSX.Element {
  return (
    <PanelCard title="Session progress">
      {!view.active ? (
        <div className="panel-empty">No active session</div>
      ) : (
        <MetricGroup>
          <Metric value={view.exercise} label="Exercise" size="sm" />
          <Metric value={String(view.sets)} label="Sets" size="sm" />
          <Metric value={String(view.totalReps)} label="Total reps" size="sm" />
          <Metric value={`${view.totalVolume.toFixed(1)} lb`} label="Volume" size="sm" />
        </MetricGroup>
      )}
    </PanelCard>
  );
}
