/**
 * Exercise hero panel (VMCP-01.50, Phase 6 — layout cohesion).
 *
 * Recomposes the former co-equal "Current set" + "Sets this session" grid tiles
 * into a single exercise-centric HERO, mirroring titan's ActiveWorkoutPage
 * composition — an exercise as the hero with its sets nested inside it — rather
 * than scattered equal-weight panels. The BodyMap / Session / Rest panels move to
 * a supporting rail (see main.tsx), giving the dashboard the hierarchy + flow of
 * the mobile app's designed workout UX instead of a flat card grid.
 *
 * Component choice: this adopts the ActiveWorkoutPage *pattern* (hero + nested
 * sets) using titan Card/Metric/VelocityStrip/Table, NOT titan's literal
 * ExerciseCard/SetRow. Those organisms have fixed SET/PREV/REPS/WEIGHT/RPE
 * columns; the dashboard carries Mode + Peak-velocity and never captures RPE, so
 * SetRow would render empty PREV/RPE columns and drop the Peak column (see the
 * original note in the retired SetLogPanel). The Table primitives give true
 * column parity while staying titan components.
 *
 * a11y (preserves Phase 5): exposed as an ARIA region named for the exercise; the
 * nested set table is aria-live="polite" so a completed set announces once (the
 * row count changes only on set close, never mid-set — see reduceSnapshot).
 *
 * NDA: renders adapter view-models only — no protocol data crosses this boundary.
 */
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Metric,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VelocityStrip,
} from '@titan-design/react-ui';
import type { CurrentSetView, SetLogRow } from '../adapter';

export interface ExerciseHeroProps {
  /** Active-session exercise name; `'—'` when idle. */
  exercise: string;
  /** Whether a session is active (drives title + empty state). */
  hasSession: boolean;
  currentSet: CurrentSetView;
  setLog: SetLogRow[];
}

export function ExerciseHeroPanel({
  exercise,
  hasSession,
  currentSet,
  setLog,
}: ExerciseHeroProps): React.JSX.Element {
  const named = hasSession && exercise !== '—';
  const title = named ? exercise : 'No active session';
  const activeRowIndex = setLog.length + 1;
  const showSetTable = setLog.length > 0 || currentSet.active;

  return (
    <section className="hero" role="region" aria-label={named ? exercise : 'Current exercise'}>
      <Card variant="elevated" elevation={2}>
        <CardHeader className="px-6 py-5">
          <div className="hero-title-row">
            <CardTitle className="text-2xl font-bold text-text-primary">{title}</CardTitle>
            {currentSet.active && <span className="hero-live-tag">● Live set</span>}
          </div>
        </CardHeader>
        <CardContent className="px-6 pt-0 pb-6">
          {!hasSession ? (
            <div className="panel-empty">No active session — start a set to begin.</div>
          ) : (
            <>
              {currentSet.active && (
                <>
                  <div className="hero-metrics">
                    <Metric value={currentSet.weight} label="Weight" size="lg" />
                    <Metric value={currentSet.repsLabel} label="Reps" size="lg" />
                    <Metric value={currentSet.velocityLoss} label="Velocity loss" size="lg" />
                    <Metric value={currentSet.latestPeakVelocity} label="Latest peak" size="md" />
                    <Metric value={currentSet.mode} label="Mode" size="md" />
                  </div>
                  {currentSet.velocitiesMps.length > 0 && (
                    <div className="velocity-wrap">
                      <div className="velocity-caption">Peak velocity per rep (m/s)</div>
                      <VelocityStrip
                        velocities={currentSet.velocitiesMps}
                        variant="full"
                        expanded
                        showInfo={false}
                      />
                    </div>
                  )}
                </>
              )}

              <div
                className={`hero-sets${currentSet.active ? ' hero-sets-spaced' : ''}`}
                aria-live="polite"
                aria-atomic="false"
              >
                <div className="velocity-caption">Sets this session</div>
                {!showSetTable ? (
                  <div className="panel-empty">No sets yet</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow isHoverable={false}>
                        <TableHeaderCell align="left" width={40}>
                          #
                        </TableHeaderCell>
                        <TableHeaderCell align="right">Weight</TableHeaderCell>
                        <TableHeaderCell align="right">Mode</TableHeaderCell>
                        <TableHeaderCell align="right">Reps</TableHeaderCell>
                        <TableHeaderCell align="right">Peak vel</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {setLog.map((row) => (
                        <TableRow key={row.index} isHoverable={false}>
                          <TableCell align="left" width={40}>
                            {String(row.index)}
                          </TableCell>
                          <TableCell align="right">{row.weight}</TableCell>
                          <TableCell align="right">{row.mode}</TableCell>
                          <TableCell align="right">{String(row.reps)}</TableCell>
                          <TableCell align="right">{row.peakVelocity}</TableCell>
                        </TableRow>
                      ))}
                      {currentSet.active && (
                        <TableRow isHoverable={false}>
                          <TableCell align="left" width={40}>
                            {String(activeRowIndex)}
                          </TableCell>
                          <TableCell align="right">{currentSet.weight}</TableCell>
                          <TableCell align="right">{currentSet.mode}</TableCell>
                          <TableCell align="right">{currentSet.repsLabel}</TableCell>
                          <TableCell align="right">{currentSet.latestPeakVelocity}</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
