/**
 * Seam 1 — `WorkoutDataSource` (transport).
 *
 * Per-device, at `WorkoutSample` grain. A fleet manager (mobile `connection-store`,
 * a dashboard slot manager) multiplexes a `Map<deviceId, WorkoutDataSource>` above it.
 * `control` is OPTIONAL: present on BLE (mobile), undefined on the dashboard SSE source
 * until the Phase-2 mutation API + auth land. Undefined ⇒ read-only source.
 */

import type { WorkoutSample } from '@voltras/workout-analytics';
import type {
  ConnectionState,
  DeviceSettings,
  SetLifecycleEvent,
  TrainingModeName,
  Unsubscribe,
} from './types.js';

export interface WorkoutDataSource {
  // reactive
  onSample(cb: (s: WorkoutSample) => void): Unsubscribe;
  onSettings(cb: (s: DeviceSettings) => void): Unsubscribe; // weight/chains/ecc/mode
  onConnection(cb: (s: ConnectionState) => void): Unsubscribe;
  onSetLifecycle(cb: (e: SetLifecycleEvent) => void): Unsubscribe; // started/ended → store reset
  onBattery?(cb: (pct: number) => void): Unsubscribe;
  // synchronous getters
  getConnectionState(): ConnectionState;
  getSettings(): DeviceSettings | null;
  // control — undefined ⇒ read-only source
  control?: WorkoutControl;
}

/** Mirrors mobile `voltra-store` control methods. Present on BLE; on the dashboard only
 *  once the Phase-2 mutation API + auth land. */
export interface WorkoutControl {
  setWeight(lbs: number): Promise<void>;
  setChains(lbs: number): Promise<void>;
  setEccentric(pct: number): Promise<void>;
  setMode(mode: TrainingModeName): Promise<void>;
  startRecording(): Promise<void>;
  endSet(): Promise<number>; // returns set duration ms
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
