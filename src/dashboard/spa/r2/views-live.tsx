/**
 * LiveView + RestView — the converged Live experience on REAL titan
 * components.
 *
 * Metric priority per operator reorder: exercise → weight+reps → sets →
 * human-readable status; velocity de-emphasized below the chart. Headline
 * velocity = MEAN CONCENTRIC (WA-D02); peak is secondary only.
 *
 * Shipped-reality annotations (amber): VelocityStrip's zone colors are
 * barbell-hardcoded (pending WA-02.04) and its VL math is first→last
 * (pending WA-02.05 / TD-03.48). We render the real behavior, annotated.
 */
import React from 'react';
import {
  Heading,
  Metric,
  MetricGroup,
  RestTimer,
  TempoBar,
  VelocityStrip,
  calculateMeanVelocity,
  calculateVelocityLoss,
  formatVelocity,
  type RestTimerProps,
} from '@titan-design/react-ui';
import { LIVE, SESSION } from './fixture';
import type { SimState } from './sim';
import { F, PendingNote } from './fidelity';
import { CueFlag, FatigueMeter, StatusPill, auraFor } from './status';

/**
 * npm titan 0.4.0 lacks `displayOnly` (merged on titan main via #81,
 * unreleased). Compiled against 0.4.0 types, so widen the prop; when the
 * build aliases titan to a local main dist the prop is honored for real, and
 * on npm 0.4.0 a CSS fallback hides the action buttons (see r2.css).
 */
const RestTimerCompat = RestTimer as React.ComponentType<
  RestTimerProps & { displayOnly?: boolean }
>;

export function LiveView({ sim }: { sim: SimState }): React.JSX.Element {
  const ex = SESSION[LIVE.exerciseIndex];
  const reps = sim.reps;
  const mean = reps.length ? calculateMeanVelocity(reps) : 0;
  const peak = reps.length ? Math.max(...reps) : 0;
  const loss = calculateVelocityLoss(reps);
  const aura = auraFor(loss, reps.length);
  return (
    <div className={`r2-live${aura ? ` aura-${aura}` : ''}`}>
      <div className="r2-live-head">
        <div>
          <F kind="real" name="titan:Heading" block={false}>
            <Heading level={2}>{ex.name}</Heading>
          </F>
          <F kind="real" name="titan:Metric ×3 (MetricGroup)">
            <MetricGroup>
              <Metric label="Weight" value={String(ex.weight)} unit="lbs" />
              <Metric label="Reps" value={`${reps.length} / ${LIVE.targetReps}`} />
              <Metric label="Set" value={`${LIVE.setIndex + 1} of ${ex.sets.length}`} />
            </MetricGroup>
          </F>
        </div>
        <div className="r2-live-status">
          <F kind="new" name="StatusPill + aura">
            <StatusPill lossPct={loss} repCount={reps.length} />
          </F>
          <span className="r2-live-ctx">Pull A · Intensification wk3 · progress in rail ◂</span>
        </div>
      </div>
      <div className="r2-live-mid">
        <div className="r2-live-left">
          <div className="r2-panel-label">
            Per-rep velocity · mean concentric (m/s)
            <PendingNote>zones barbell-hardcoded — pending WA-02.04</PendingNote>
          </div>
          <F kind="real" name="titan:VelocityStrip (expanded)">
            <VelocityStrip velocities={reps} expanded showInfo />
          </F>
          <div className="r2-live-vel">
            <F kind="real" name="titan:Metric" block={false}>
              <Metric label="Mean concentric" value={formatVelocity(mean)} unit="m/s" size="lg" />
            </F>
            <F kind="real" name="titan:Metric" block={false}>
              <Metric label="Peak (secondary)" value={formatVelocity(peak)} unit="m/s" size="sm" />
            </F>
            <PendingNote>
              VL {Math.round(loss)}% is first→last — pending WA-02.05 / TD-03.48
            </PendingNote>
          </div>
        </div>
        <div className="r2-live-right">
          <div className="r2-panel-label">Live tempo · CON→HOLD→ECC (real pacing ✓/✗)</div>
          <F kind="real" name="titan:TempoBar">
            <TempoBar
              activePhase={sim.phase}
              phaseElapsedMs={sim.phaseElapsedMs}
              completed={sim.completed}
              target={{
                concentric: ex.tempoMs.con / 1000,
                hold: ex.tempoMs.hold / 1000,
                eccentric: ex.tempoMs.ecc / 1000,
              }}
            />
          </F>
          <div className="r2-panel-label">Fatigue · auto-regulation</div>
          <F kind="new" name="FatigueMeter (C meter + A aura + cue)">
            <FatigueMeter lossPct={loss} />
          </F>
          <CueFlag lossPct={loss} repCount={reps.length} />
        </div>
      </div>
    </div>
  );
}

export function RestView({ sim }: { sim: SimState }): React.JSX.Element {
  const ex = SESSION[LIVE.exerciseIndex];
  const done = LIVE.stream;
  const mean = calculateMeanVelocity(done);
  const loss = calculateVelocityLoss(done);
  return (
    <div className="r2-rest">
      <div className="r2-rest-left" data-rt-fallback>
        <F kind="real" name="titan:RestTimer" note="displayOnly — merged titan #81, unreleased">
          <RestTimerCompat
            totalSeconds={LIVE.restSeconds}
            elapsedMs={sim.restElapsedMs}
            onSkip={() => undefined}
            onAddTime={() => undefined}
            nextSetInfo={`Set ${LIVE.setIndex + 2} of ${ex.sets.length} — ${LIVE.targetReps} × ${ex.weight} lbs`}
            visible
            displayOnly
          />
        </F>
      </div>
      <div className="r2-rest-right">
        <div className="r2-rest-card">
          <div className="r2-rest-cat">Set {LIVE.setIndex + 1} verdict · rep-quality</div>
          <div className="r2-rest-line">
            Solid work set — held above the VL20 line to the last rep.
          </div>
          <F kind="real" name="titan:Metric ×4 (MetricGroup)">
            <MetricGroup>
              <Metric size="sm" label="Reps" value={String(done.length)} />
              <Metric size="sm" label="Mean con" value={formatVelocity(mean)} unit="m/s" />
              <Metric size="sm" label="Loss" value={`−${Math.round(loss)}%`} />
              <Metric size="sm" label="e1RM" value={String(ex.e1rm)} unit="lbs" />
            </MetricGroup>
          </F>
        </div>
        <F kind="mock" name="next-set panel (rest-only rule)">
          <div className="r2-nextset">
            <div className="r2-nextset-k">
              ▶ Next set · {LIVE.setIndex + 2} of {ex.sets.length}
            </div>
            <div className="r2-nextset-big">
              {LIVE.targetReps} × {ex.weight} lbs
            </div>
            <div className="r2-nextset-sub">
              Hold mean concentric ≥ 0.55 m/s · next-set info shown only during rest
            </div>
          </div>
        </F>
      </div>
    </div>
  );
}
