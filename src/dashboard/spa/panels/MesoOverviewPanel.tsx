/**
 * Meso-overview panel (VMCP-01.58, VW-18 S3).
 *
 * The active mesocycle's week-by-week structure: a stack of titan `WeekRow`s —
 * each week's workout pills (completed / current / upcoming), a planned-volume
 * intensity bar, and deload / current-week treatment. Complements the summary
 * `MesoStatusPanel` (block progress at a glance) with the full week ladder from
 * `GET /api/meso-overview`.
 *
 * Hidden when no mesocycle is in progress (server returns null / no weeks).
 * NDA: plan metadata only.
 */
import { WeekRow } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';
import { toWeekRowPropsList, type MesoOverviewView } from './meso-overview-view';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function MesoOverviewPanel({
  meso,
}: {
  meso: MesoOverviewView | null;
}): React.JSX.Element | null {
  if (meso === null || meso.weeks.length === 0) return null;
  const title = meso.focus !== undefined ? `Mesocycle · ${cap(meso.focus)}` : 'Mesocycle';
  return (
    <PanelCard title={title}>
      <div className="meso-overview-weeks">
        {toWeekRowPropsList(meso).map((row) => (
          <WeekRow key={row.weekNumber} {...row} />
        ))}
      </div>
    </PanelCard>
  );
}
