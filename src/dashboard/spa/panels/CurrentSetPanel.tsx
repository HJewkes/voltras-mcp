/**
 * Current-set panel (VMCP-01.45).
 *
 * Composes titan `Metric` tiles for the live readouts (weight, mode, reps,
 * latest peak velocity, target weight) and a titan `VelocityStrip` for the
 * per-rep peak-velocity bar chart. Values are pre-formatted by the adapter
 * (velocities mm/s→m/s, weights lbs) so units match the legacy dashboard.
 */
import { Metric, VelocityStrip } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import type { CurrentSetView } from '../adapter';

export function CurrentSetPanel({ view }: { view: CurrentSetView }): React.JSX.Element {
  return (
    <PanelCard title="Current set">
      {!view.active ? (
        <div className="panel-empty">No active set</div>
      ) : (
        <>
          <div className="metric-grid">
            <Metric value={view.weight} label="Weight" size="md" />
            <Metric value={view.mode} label="Mode" size="md" />
            <Metric value={String(view.reps)} label="Reps" size="md" />
            <Metric value={view.latestPeakVelocity} label="Latest peak vel" size="md" />
            <Metric value={view.targetWeight} label="Target weight" size="md" />
          </div>
          {view.velocitiesMps.length > 0 && (
            <div className="velocity-wrap">
              <div className="velocity-caption">Peak velocity per rep (m/s)</div>
              <VelocityStrip
                velocities={view.velocitiesMps}
                variant="full"
                expanded
                showInfo={false}
              />
            </div>
          )}
        </>
      )}
    </PanelCard>
  );
}
