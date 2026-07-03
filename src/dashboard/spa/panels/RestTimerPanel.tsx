/**
 * Rest-timer panel (VMCP-01.45).
 *
 * Renders the count-up "time since last set ended" as a large titan `Metric`.
 *
 * Note on component choice: titan's `RestTimer` organism is a *countdown* with a
 * target duration, progress bar, and Skip / +30s actions — it models a planned
 * rest interval. The legacy dashboard rest panel is a target-less count-*up*
 * elapsed display with no actions, and the snapshot carries no rest target, so
 * `RestTimer` doesn't fit the parity target. `Metric` (big value + caption)
 * matches the legacy layout while staying a titan organism.
 */
import { Metric } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import { fmtElapsed } from '../adapter';

export function RestTimerPanel({ elapsedMs }: { elapsedMs: number | null }): React.JSX.Element {
  const value = elapsedMs == null ? '—' : fmtElapsed(elapsedMs);
  return (
    <PanelCard title="Rest timer">
      <div className="rest-timer-body">
        <Metric value={value} label="since last set ended" size="lg" />
      </div>
    </PanelCard>
  );
}
