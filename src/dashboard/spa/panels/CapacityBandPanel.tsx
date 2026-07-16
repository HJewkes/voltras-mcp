/**
 * Capacity-band panel (VMCP-01.55, Track B).
 *
 * Renders titan's `CapacityBandChart` — a shaded strength-capacity corridor over
 * past sessions of the active exercise, with each session's best e1RM plotted as a
 * dot (colored by whether it sat within / above / below the band). The corridor is
 * WA's `StateSpaceStrengthModel` estimate ± k·σ, folded server-side
 * (`GET /api/capacity-band`); this panel is pure titan render over the mapped props.
 *
 * Hidden until the band has points — the server gates on a minimum session count
 * (`MIN_CAPACITY_BAND_SESSIONS`), so an empty series means "not enough history yet".
 * Confidentiality: derived fitness metadata only.
 */
import { CapacityBandChart } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import { toCapacityBandChartData, type CapacityBandPoint } from './capacity-band-view';

const CHART_WIDTH = 300;
const CHART_HEIGHT = 160;

export function CapacityBandPanel({
  points,
}: {
  points: CapacityBandPoint[];
}): React.JSX.Element | null {
  if (points.length === 0) return null;
  const { band, workouts } = toCapacityBandChartData(points);
  return (
    <PanelCard title="Capacity band">
      <div className="strength-trend-body">
        <CapacityBandChart
          band={band}
          workouts={workouts}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
        />
      </div>
    </PanelCard>
  );
}
