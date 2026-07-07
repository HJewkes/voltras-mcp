/**
 * PinnedLiveStrip — NET-NEW shell component (Phase-2 seed).
 *
 * D's keeper: whenever the sim set is running and the user is NOT on Live,
 * this strip pins to the top of the main viewport so the live set is never
 * lost. Composes the REAL titan VelocityStrip (mini variant) + Metric.
 */
import React from 'react';
import {
  Metric,
  VelocityStrip,
  calculateMeanVelocity,
  formatVelocity,
} from '@titan-design/react-ui';
import { F } from './fidelity';

export function PinnedLiveStrip({
  reps,
  targetReps,
  exerciseName,
  setLabel,
  resting,
  restLabel,
  onReturn,
}: {
  reps: number[];
  targetReps: number;
  exerciseName: string;
  setLabel: string;
  resting: boolean;
  restLabel: string;
  onReturn: () => void;
}): React.JSX.Element {
  const mean = reps.length ? calculateMeanVelocity(reps) : 0;
  return (
    <div className="r2-strip" role="status" aria-label="Live set in progress">
      <span className="r2-strip-live">
        <span className="r2-strip-dot" aria-hidden="true" />
        {resting ? 'Resting' : 'Live'}
      </span>
      <span className="r2-strip-name">
        {exerciseName} · {setLabel}
      </span>
      {resting ? (
        <span className="r2-strip-rest">{restLabel}</span>
      ) : (
        <>
          <F kind="real" name="titan:Metric" block={false}>
            <Metric size="sm" label="Rep" value={`${reps.length}/${targetReps}`} />
          </F>
          <F kind="real" name="titan:Metric" block={false}>
            <Metric size="sm" label="Mean con" value={formatVelocity(mean)} unit="m/s" />
          </F>
          <span className="r2-strip-bars">
            <F kind="real" name="titan:VelocityStrip mini" block={false}>
              <VelocityStrip velocities={reps} variant="mini" />
            </F>
          </span>
        </>
      )}
      <button type="button" className="r2-strip-return" onClick={onReturn}>
        return to Live ▸
      </button>
    </div>
  );
}
