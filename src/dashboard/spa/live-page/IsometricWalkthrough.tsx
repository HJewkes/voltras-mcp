// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { CircularTimer, useOnSurfaceColor, useTimer } from '@titan-design/react-ui';
import type { LiveIsometricSignal } from '../../../state/live-signal.js';

/** Ring diameter (px) — a corner overlay, not a full stage, so smaller than RestView's. */
const RING_SIZE = 140;

const PHASE_LABEL: Record<LiveIsometricSignal['phase'], string> = {
  ready: 'Get set',
  go: 'Pull now',
  hold: 'Hold max',
  stop: 'Stop and release',
};

/**
 * The isometric-hold walkthrough overlay (VW-198, the VW-154 second half): a corner
 * panel that steps the athlete through ready → go → hold → stop as the
 * `isometric_phase` channel events arrive, so the go/stop signalling
 * (docs/push-events.md#isometric-hold-phases) that used to be silent is now visible on
 * the wall. No spoken cue here — that half waits on the single speech queue (w3-40).
 *
 * Pure prop-driven (no store read), same technique as `RestView`/`ExerciseHeader`
 * (VW-63) — `signal` is the derived single-slot view the store already exposes for the
 * live overlay. `null` while no hold is in progress, in which case this renders nothing;
 * the store clears the slot the instant a `stop` event lands, so "no panel" also covers
 * "the last hold just ended" rather than lingering on the terminal phase.
 *
 * The hold countdown is titan's `CircularTimer` + `useTimer` — never a hand-rolled arc.
 * `useTimer`'s internal tick starts from 0 the first time `running` goes true and never
 * resets on its own; that is exactly right here because this component (and its
 * `useTimer` instance) only lives for ONE trial — the store deletes the slot on `stop`,
 * so the next `ready` mounts a fresh instance rather than reusing a stale clock.
 */
export function IsometricWalkthrough({
  signal,
}: {
  signal: LiveIsometricSignal | null;
}): ReactElement | null {
  // Hooks run unconditionally (rules of hooks) — the `null` guard is below, after.
  const labelColor = useOnSurfaceColor('primary');
  const trialColor = useOnSurfaceColor('secondary');
  const timer = useTimer({
    mode: 'down',
    durationMs: signal?.holdMs ?? 0,
    running: signal?.phase === 'hold',
    autoTick: true,
  });
  if (signal === null) return null;
  return (
    <View
      testID="isometric-walkthrough"
      style={{
        position: 'absolute',
        top: 24,
        right: 24,
        zIndex: 10,
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Text
        testID="isometric-trial"
        style={{ color: trialColor, fontSize: 12, fontWeight: '700', letterSpacing: 1 }}
      >
        HOLD {signal.trial}
      </Text>
      {signal.phase === 'hold' && (
        <CircularTimer
          durationMs={signal.holdMs}
          elapsedMs={timer.elapsedMs}
          mode="down"
          size={RING_SIZE}
          doneLabel="STOP"
        />
      )}
      <Text
        testID="isometric-phase-label"
        style={{ color: labelColor, fontSize: 20, fontWeight: '700' }}
      >
        {PHASE_LABEL[signal.phase]}
      </Text>
    </View>
  );
}
