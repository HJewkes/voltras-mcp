/**
 * ReviewView — C's per-rep tap-in on REAL titan components.
 *
 * Columns: set list (real SetRow with previous/targets + DeviationBar) →
 * set detail (real VelocityStrip expanded, per-rep tap-in via its real
 * `onRepPress`) → rep detail (real Metric grid + TempoDisplay). The
 * historical per-rep tempo bar stays a labeled MOCK exploration (derivable —
 * getRepTempo exists in WA — but no component yet). Exercise analytics
 * drill-in opens the REAL titan Drawer with the REAL StrengthTrendChart.
 */
import React, { useState } from 'react';
import {
  DeviationBar,
  Drawer,
  Heading,
  Metric,
  MetricGroup,
  PrBadge,
  SetRow,
  StrengthTrendChart,
  TempoDisplay,
  calculateMeanVelocity,
  calculateVelocityLoss,
  formatVelocity,
} from '@titan-design/react-ui';
import { VelocityStripCompat } from './titan-compat';
import { CABLE_ZONES, E1RM_TREND, SESSION } from './fixture';
import { F, PendingNote } from './fidelity';

function HistoricalTempoMock({ repCount }: { repCount: number }): React.JSX.Element {
  const bars = Array.from({ length: repCount }, (_, i) => {
    const ecc = 42 + i * 3;
    return (
      <div key={i} className="r2-htempo-col">
        <div className="r2-htempo-bar">
          <div style={{ height: '28%', background: 'var(--color-status-success)' }} />
          <div style={{ height: '12%', background: 'var(--color-brand-secondary, #406D87)' }} />
          <div style={{ height: `${ecc}%`, background: 'var(--color-brand-primary, #FF7900)' }} />
        </div>
        <span className="r2-htempo-lbl">r{i + 1}</span>
      </div>
    );
  });
  return <div className="r2-htempo">{bars}</div>;
}

export function ReviewView({ exerciseId }: { exerciseId: string }): React.JSX.Element {
  const [setIdx, setSetIdx] = useState<number>(2);
  const [repIdx, setRepIdx] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const ex = SESSION.find((e) => e.id === exerciseId) ?? SESSION[0];
  const set = ex.sets[Math.min(setIdx, ex.sets.length - 1)];
  const mean = calculateMeanVelocity(set.velocities);
  const loss = calculateVelocityLoss(set.velocities);
  const repVel = repIdx != null ? set.velocities[repIdx] : null;

  return (
    <div className="r2-review">
      <div className="r2-col r2-col-sets">
        <div className="r2-col-head">
          <span className="r2-col-lvl">Set</span>
          <Heading level={3}>{ex.name}</Heading>
          <button type="button" className="r2-link" onClick={() => setDrawerOpen(true)}>
            ▤ trend / analytics drawer
          </button>
        </div>
        {ex.sets.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`r2-setrow-wrap${i === setIdx ? ' sel' : ''}`}
            onClick={() => {
              setSetIdx(i);
              setRepIdx(null);
            }}
          >
            <F kind="real" name="titan:SetRow (previous+targets restored)">
              <SetRow
                mode="history"
                setNumber={i + 1}
                previous={s.previous}
                reps={s.reps}
                weight={ex.weight}
                rpe={s.rpe}
                unit="lbs"
                velocities={s.velocities}
                targets={{ reps: s.reps, weight: ex.weight }}
                prBadges={i === 0 && ex.pr ? [{ type: 'e1rm', label: 'e1RM PR' }] : undefined}
              />
            </F>
            <F kind="real" name="titan:DeviationBar" block={false}>
              <DeviationBar deviation={(i - 1) * 0.12} width={90} />
            </F>
          </button>
        ))}
      </div>
      <div className="r2-col r2-col-detail">
        <div className="r2-col-head">
          <span className="r2-col-lvl">Set detail</span>
          <Heading level={3}>Set {setIdx + 1}</Heading>
          <span className="r2-col-sub">
            {set.reps} × {ex.weight} lbs · RPE {set.rpe}
          </span>
        </div>
        <F kind="real" name="titan:Metric ×3 (MetricGroup)">
          <MetricGroup>
            <Metric label="Mean concentric" value={formatVelocity(mean)} unit="m/s" />
            <Metric label="Vel loss" value={`−${Math.round(loss)}%`} />
            <Metric
              label="Best rep"
              value={formatVelocity(Math.max(...set.velocities))}
              unit="m/s"
            />
          </MetricGroup>
        </F>
        <div className="r2-panel-label">
          Per-rep velocity · tap a bar to drill (real onRepPress)
          <PendingNote>
            zones + fromBest loss live via titan v0.5.0 (#83) — npm 0.4.0 fallback: barbell scale,
            first→last
          </PendingNote>
        </div>
        <F kind="real" name="titan:VelocityStrip (expanded, onRepPress, zones)">
          <VelocityStripCompat
            velocities={set.velocities}
            expanded
            showInfo
            zones={CABLE_ZONES}
            onRepPress={(i) => setRepIdx(i)}
          />
        </F>
        <div className="r2-panel-label">Historical tempo · per-rep CON/HOLD/ECC</div>
        <F
          kind="mock"
          name="historical tempo bar"
          note="exploration — WA getRepTempo exists, no component yet"
        >
          <HistoricalTempoMock repCount={set.velocities.length} />
        </F>
      </div>
      {repIdx != null && repVel != null && (
        <div className="r2-col r2-col-rep">
          <div className="r2-col-head">
            <span className="r2-col-lvl">Rep</span>
            <Heading level={3}>Rep {repIdx + 1}</Heading>
            <span className="r2-col-sub">of {set.velocities.length}</span>
          </div>
          <F kind="real" name="titan:Metric ×4 (2 MetricGroups)">
            <>
              <MetricGroup>
                <Metric
                  label="Mean concentric"
                  value={formatVelocity(repVel)}
                  unit="m/s"
                  size="lg"
                />
                <Metric
                  label="Peak (secondary)"
                  value={formatVelocity(repVel * 1.28)}
                  unit="m/s"
                  size="sm"
                />
              </MetricGroup>
              <MetricGroup>
                <Metric
                  label="Loss vs best"
                  value={`−${Math.round(((Math.max(...set.velocities) - repVel) / Math.max(...set.velocities)) * 100)}%`}
                  size="sm"
                />
                <Metric
                  label="Est. force"
                  value={String(Math.round(ex.weight * 4.45 * (1 + repVel * 0.4)))}
                  unit="N"
                  size="sm"
                />
              </MetricGroup>
            </>
          </F>
          <div className="r2-panel-label">Tempo prescription</div>
          <F kind="real" name="titan:TempoDisplay">
            <TempoDisplay
              tempo={[ex.tempoMs.ecc / 1000, ex.tempoMs.hold / 1000, ex.tempoMs.con / 1000, 0]}
              colored
              showInfo
            />
          </F>
        </div>
      )}
      <F kind="real" name="titan:Drawer (right) + StrengthTrendChart + PrBadge">
        <Drawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          placement="right"
          title={`${ex.name} · analytics`}
        >
          <div className="r2-drawer-body">
            <PrBadge type="e1rm" label="e1RM PR · 205 lbs" />
            <div className="r2-panel-label">Strength trend · e1RM across sessions</div>
            <StrengthTrendChart data={E1RM_TREND} width={360} height={160} unit="lbs" />
            <F kind="mock" name="LV profile slot">
              <div className="r2-stub-slot">
                Load–velocity profile — exercise-detail crib, not yet composed
              </div>
            </F>
          </div>
        </Drawer>
      </F>
    </div>
  );
}
