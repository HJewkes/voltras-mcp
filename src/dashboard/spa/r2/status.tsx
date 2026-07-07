/**
 * StatusPill + background aura + FatigueMeter — NET-NEW shell components.
 *
 * The human-readable state treatment from the R2 synthesis: a status pill
 * (productive / threshold / stop), A's stage-level radial aura, and C's
 * needle fatigue meter.
 *
 * SHIPPED-REALITY NOTE: the velocity-loss driving these states is computed
 * with titan's real `calculateVelocityLoss` (FIRST→LAST rep) — pending
 * WA-02.05 / TD-03.48 this will switch to running-best. We render actual
 * shipped behavior and annotate, per the harness fidelity rules.
 */
import React from 'react';

export type AuraLevel = '' | 'amber' | 'red';

export function auraFor(lossPct: number, repCount: number): AuraLevel {
  if (repCount === 0) return '';
  if (lossPct >= 28) return 'red';
  if (lossPct >= 20) return 'amber';
  return '';
}

export function StatusPill({
  lossPct,
  repCount,
}: {
  lossPct: number;
  repCount: number;
}): React.JSX.Element {
  const level = auraFor(lossPct, repCount);
  const text =
    level === 'red'
      ? `Stop · velocity loss ${Math.round(lossPct)}%`
      : level === 'amber'
        ? 'Threshold · VL20 reached'
        : 'Productive · in the band';
  return (
    <span className={`r2-status-pill${level ? ` ${level}` : ''}`} role="status">
      <span className="r2-status-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function FatigueMeter({ lossPct }: { lossPct: number }): React.JSX.Element {
  const left = Math.min(98, (lossPct / 40) * 100);
  return (
    <div className="r2-fmeter-wrap">
      <div className="r2-fmeter">
        <div className="r2-fneedle" style={{ left: `${left}%` }} />
      </div>
      <div className="r2-fscale">
        <span>fresh</span>
        <span>VL10</span>
        <span>VL20</span>
        <span>VL30</span>
        <span>stop</span>
      </div>
    </div>
  );
}

export function CueFlag({ lossPct, repCount }: { lossPct: number; repCount: number }) {
  const level = auraFor(lossPct, repCount);
  if (!level) return null;
  return (
    <div className={`r2-cue ${level}`} role="alert">
      {level === 'red'
        ? `■ Velocity loss ${Math.round(lossPct)}% — end the set now.`
        : '▲ VL20 · target reps met — final rep or end set.'}
    </div>
  );
}
