/**
 * SessionPaceTile — NET-NEW shell component (Phase-2 seed), MOCK derivation.
 *
 * D's Session Pace: volume/load/fatigue + time-in-workout against a fixed
 * budget, with a trim/add suggestion for the fixed-period case. There is NO
 * workout-analytics support for any of this yet (see component-audit.md §4.1)
 * — every number and the suggestion text are mock, and labeled as such.
 * Composes the REAL titan CapacityBandChart + Metric.
 */
import React, { useState } from 'react';
import { CapacityBandChart, Metric, MetricGroup } from '@titan-design/react-ui';
import { CAPACITY_BAND, PACE } from './fixture';
import { F } from './fidelity';

function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function SessionPaceTile(): React.JSX.Element {
  const [ahead, setAhead] = useState(false);
  const pct = Math.min(100, (PACE.elapsedSec / PACE.budgetSec) * 100);
  return (
    <div className="r2-pace">
      <div className="r2-pace-head">
        <span className="r2-pace-title">Session Pace</span>
        <button type="button" className="r2-pace-toggle" onClick={() => setAhead((v) => !v)}>
          {ahead ? 'show behind ▸' : 'show ahead ▸'}
        </button>
      </div>
      <div className="r2-pace-time">
        <span className="r2-pace-big">{mmss(PACE.elapsedSec)}</span>
        <span className="r2-pace-of">of {mmss(PACE.budgetSec)} budget</span>
      </div>
      <div className="r2-pace-bar">
        <div
          className="r2-pace-fill"
          style={{
            width: `${pct}%`,
            background: ahead ? 'var(--color-status-success)' : 'var(--color-status-warning)',
          }}
        />
      </div>
      <F kind="real" name="titan:Metric ×3 (MetricGroup)">
        <MetricGroup>
          <Metric size="sm" label="Volume" value={`${PACE.volumeDonePct}%`} />
          <Metric
            size="sm"
            label="Load"
            value={`${(PACE.loadLbs / 1000).toFixed(1)}k`}
            unit="lbs"
          />
          <Metric size="sm" label="Fatigue" value="MOD" />
        </MetricGroup>
      </F>
      <div className={`r2-pace-suggest ${ahead ? 'ahead' : 'behind'}`}>
        {ahead
          ? '＋ Ahead of pace — ~7 min headroom. Room to add a Cable Fly drop-set.'
          : '▲ Behind pace — ~9 min over budget at this rate. Drop Face Pull to 2 sets to finish on time.'}
      </div>
      <F kind="real" name="titan:CapacityBandChart">
        <CapacityBandChart
          band={CAPACITY_BAND.band}
          workouts={CAPACITY_BAND.workouts}
          width={206}
          height={56}
        />
      </F>
    </div>
  );
}
