/**
 * LiveView + RestView — Direction C's composition on real titan components.
 *
 * Live = C's "fantastic main live view" (operator): full-height hero bar area
 * (best use of space), big velocity numeral — now the latest rep's MEAN
 * concentric per WA-D02, peak secondary — C's right-stack (numeral →
 * rep/mean/loss row → live tempo → fatigue/auto-reg with VL markers), and the
 * load reflected prominently. Set progress lives in the rail (converged
 * contract), not here.
 *
 * The hero bar area is the labeled NET-NEW `HeroVelocityBars` (candidate
 * titan VelocityStrip 'hero' variant) — the real VelocityStrip's compact
 * expanded form can't stretch to C's proportions. It shares the WA-shaped
 * cable `zones` bands the real VelocityStrip consumes (titan #83 / v0.5.0),
 * so hero and strip agree on zoning.
 *
 * Rest = C's "beautiful timer + really good context": NET-NEW RestRing
 * (candidate RestTimer ring variant) + C's verdict/status context + rest-only
 * next-set panel; the REAL RestTimer (displayOnly, #81) renders below the
 * ring for shipped-behavior comparison.
 */
import React from 'react';
import {
  Heading,
  Metric,
  MetricGroup,
  TempoBar,
  calculateMeanVelocity,
  calculateVelocityLoss,
  formatVelocity,
} from '@titan-design/react-ui';
import { CABLE_ZONES, LIVE, SESSION } from './fixture';
import type { SimState } from './sim';
import { F, PendingNote } from './fidelity';
import { CueFlag, FatigueMeter, StatusPill, auraFor } from './status';
import { HeroVelocityBars, heroZoneColor } from './herobars';
import { RestRing } from './restring';
import { RestTimerCompat } from './titan-compat';
import { WallScale } from './wallscale';

export function LiveView({ sim }: { sim: SimState }): React.JSX.Element {
  const ex = SESSION[LIVE.exerciseIndex];
  const reps = sim.reps;
  const latest = reps.length ? reps[reps.length - 1] : null;
  const setMean = reps.length ? calculateMeanVelocity(reps) : 0;
  const loss = calculateVelocityLoss(reps);
  const aura = auraFor(loss, reps.length);
  return (
    <div className={`r2-live${aura ? ` aura-${aura}` : ''}`}>
      <div className="r2-live-head">
        <div>
          <F kind="real" name="titan:Heading" block={false}>
            <Heading level={2}>{ex.name}</Heading>
          </F>
          <div className="r2-live-load">
            <span className="r2-live-load-num">{ex.weight}</span>
            <span className="r2-live-load-unit">lbs</span>
            <span className="r2-live-load-sub">
              SET {LIVE.setIndex + 1}/{ex.sets.length} · Pull A · Intensification wk3
            </span>
          </div>
        </div>
        <div className="r2-live-status">
          <F kind="new" name="StatusPill + aura">
            <StatusPill lossPct={loss} repCount={reps.length} />
          </F>
          <span className="r2-live-ctx">set progress in rail ◂</span>
        </div>
      </div>
      <div className="r2-live-mid">
        <div className="r2-live-left">
          <div className="r2-panel-label">
            Per-rep velocity · mean concentric (m/s)
            <PendingNote>
              cable zones via VelocityStrip `zones` (titan #83 / v0.5.0) — WA-02.04 shape; npm 0.4.0
              fallback = barbell scale
            </PendingNote>
          </div>
          <F kind="new" name="HeroVelocityBars — candidate titan VelocityStrip 'hero' variant">
            <HeroVelocityBars velocities={reps} targetReps={LIVE.targetReps} zones={CABLE_ZONES} />
          </F>
        </div>
        <div className="r2-live-right">
          <div className="r2-heropeak">
            <span
              className="r2-heropeak-v"
              style={{ color: latest != null ? heroZoneColor(latest, CABLE_ZONES) : undefined }}
            >
              {latest != null ? formatVelocity(latest) : '—'}
            </span>
            <span className="r2-heropeak-u">m/s mean concentric · latest rep</span>
            <span className="r2-heropeak-peak">
              peak (secondary) {latest != null ? formatVelocity(latest * 1.27) : '—'} m/s
            </span>
          </div>
          <F kind="real" name="titan:Metric ×3 (MetricGroup)">
            <MetricGroup>
              <Metric label="Rep" value={`${reps.length}/${LIVE.targetReps}`} />
              <Metric label="Set mean" value={formatVelocity(setMean)} unit="m/s" />
              <Metric label="Loss" value={`−${Math.round(loss)}%`} />
            </MetricGroup>
          </F>
          <div>
            <div className="r2-panel-label">Live tempo · CON→HOLD→ECC (real pacing ✓/✗)</div>
            <F
              kind="new"
              name="TempoBar size='wall' — candidate variant"
              note="scaled REAL TempoBar DOM ×1.6, capabilities identical"
            >
              <WallScale factor={1.6}>
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
              </WallScale>
            </F>
          </div>
          <div>
            <div className="r2-panel-label">
              Fatigue · auto-regulation
              <PendingNote>
                loss ref = running-best (titan v0.5.0, WA-D01) — WA lib impl pending WA-02.05
              </PendingNote>
            </div>
            <F
              kind="new"
              name="FatigueMeter size='wall' — candidate variant"
              note="same gradient/needle/VL-marker structure, wall density"
            >
              <FatigueMeter lossPct={loss} size="wall" />
            </F>
          </div>
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
        <div className="r2-panel-label">Rest · next set in</div>
        <F kind="new" name="RestRing — candidate titan RestTimer ring variant">
          <RestRing totalSeconds={LIVE.restSeconds} elapsedMs={sim.restElapsedMs} />
        </F>
        <span className="r2-rest-sub">
          Set {LIVE.setIndex + 1} of {ex.sets.length} complete · 1 set remaining
        </span>
        <F kind="real" name="titan:RestTimer" note="displayOnly — real, titan #81 / v0.5.0">
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
          <div className="r2-rest-note">
            Bar speed decayed smoothly · RPE 8.5 matched predicted 8.3
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
              Hold mean concentric ≥ 0.55 m/s · last set — push to a true RPE 9.5 · next-set info
              shown only during rest
            </div>
          </div>
        </F>
      </div>
    </div>
  );
}
