/**
 * Mesocycle-status panel (VW-18 coached-session wave, Phase 2).
 *
 * Renders titan's `MesoStatusCard` for the active program's current block —
 * where the lifter is in the mesocycle (block name/focus, week X of Y) and how
 * much of the block is done. Program-focused only; the per-set prescription-vs-
 * actual lives on the hero (Phase 1), so the two don't overlap.
 *
 * MesoStatusCard carries its own header/badge, so it renders inside a plain
 * region wrapper rather than PanelCard (which would double the chrome). Hidden
 * when no program is active. NDA: plan metadata only.
 */
import { MesoStatusCard } from '@titan-design/react-ui';

/** Current-block program status, matching `/api/program-status`. */
export interface ProgramStatusView {
  mesoName: string;
  focus?: string;
  weekNumber: number;
  totalWeeks: number;
  workoutsDone: number;
  workoutsPlanned: number;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function MesoStatusPanel({
  program,
}: {
  program: ProgramStatusView | null;
}): React.JSX.Element | null {
  if (program === null) return null;
  const pct = program.workoutsPlanned > 0 ? program.workoutsDone / program.workoutsPlanned : 0;
  const subtitle = `Week ${program.weekNumber} of ${program.totalWeeks}${
    program.focus !== undefined ? ` · ${cap(program.focus)}` : ''
  }`;
  return (
    <section role="region" aria-label="Mesocycle status">
      <MesoStatusCard
        mesoName={program.mesoName}
        mesoSubtitle={subtitle}
        statusBadge={{ label: 'On Track', variant: 'success' }}
        metrics={[
          { label: 'Current week', value: `${program.weekNumber} of ${program.totalWeeks}` },
          { label: 'Workouts', value: `${program.workoutsDone}/${program.workoutsPlanned}` },
        ]}
        gauges={[{ label: 'Block progress', level: pct, sublabel: `${Math.round(pct * 100)}%` }]}
      />
    </section>
  );
}
