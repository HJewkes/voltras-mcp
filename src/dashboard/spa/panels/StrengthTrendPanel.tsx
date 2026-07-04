/**
 * Strength-trend panel (VW-18 organism integration).
 *
 * Renders titan's `StrengthTrendChart` organism — a compact estimated-1RM line
 * over past sessions of the active exercise, with PR sessions starred. Data is
 * folded server-side from persisted history (`GET /api/exercise-trend`, one best
 * `estimateE1RMFromReps` point per session); this panel is a pure presenter.
 *
 * Hidden until there are at least two points — a single dot isn't a trend, and
 * the idle/first-session dashboard shouldn't show an empty chart frame.
 *
 * NDA: renders derived fitness metadata (dates + e1RM) only.
 */
import { StrengthTrendChart } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';

/** One point on the estimated-1RM trend, matching the `/api/exercise-trend` shape. */
export interface ExerciseTrendPoint {
  date: string;
  e1rm: number;
  isPR: boolean;
}

const CHART_WIDTH = 300;
const CHART_HEIGHT = 140;

export function StrengthTrendPanel({
  points,
}: {
  points: ExerciseTrendPoint[];
}): React.JSX.Element | null {
  if (points.length < 2) return null;
  return (
    <PanelCard title="Strength trend">
      <div className="strength-trend-body">
        <StrengthTrendChart
          data={points}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          unit="lbs"
          animateOnMount={false}
        />
      </div>
    </PanelCard>
  );
}
