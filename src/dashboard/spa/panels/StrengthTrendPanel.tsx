/**
 * Strength-trend panel (VW-18 organism integration + coached-session Phase 5).
 *
 * Renders titan's `StrengthTrendChart` — a compact estimated-1RM line over past
 * sessions of the active exercise, PR sessions starred (`GET /api/exercise-trend`).
 * A "PR history" affordance opens titan's `PrHistoryModal` with the exercise's
 * all-time records (`GET /api/pr-history`) — tap-to-open, consistent with the
 * dashboard's existing BodyMap taps.
 *
 * The chart is hidden until there are ≥2 points (a single dot isn't a trend);
 * the PR-history button appears whenever records exist. NDA: derived fitness
 * metadata only.
 */
import { useState } from 'react';
import { PrHistoryModal, StrengthTrendChart } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';

/** One point on the estimated-1RM trend, matching the `/api/exercise-trend` shape. */
export interface ExerciseTrendPoint {
  date: string;
  e1rm: number;
  isPR: boolean;
}

/** One PR record, matching the `/api/pr-history` shape (a titan `PrRecord`). */
export interface PrRecordView {
  type: 'e1rm' | 'weight' | 'reps' | 'velocity';
  value: number;
  unit?: 'lbs';
  date: string;
}

const CHART_WIDTH = 300;
const CHART_HEIGHT = 140;

export function StrengthTrendPanel({
  points,
  prRecords,
  exerciseName,
}: {
  points: ExerciseTrendPoint[];
  prRecords: PrRecordView[];
  exerciseName: string;
}): React.JSX.Element | null {
  const [prOpen, setPrOpen] = useState(false);
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
      {prRecords.length > 0 && (
        <button type="button" className="pr-history-link" onClick={() => setPrOpen(true)}>
          ★ PR history
        </button>
      )}
      <PrHistoryModal
        exerciseId={exerciseName}
        exerciseName={exerciseName}
        records={prRecords}
        isOpen={prOpen}
        onClose={() => setPrOpen(false)}
      />
    </PanelCard>
  );
}
