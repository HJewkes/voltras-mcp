/**
 * Phase 0 SPA entry (VMCP-01.44).
 *
 * Toolchain proof: a Vite-built, client-rendered React page that consumes the
 * `@titan-design/react-ui` component library (React Native primitives running on
 * web via react-native-web) and renders it from LIVE data polled off the
 * sidecar's existing `/api/snapshot` endpoint.
 *
 * This file imports exactly ONE titan-design component — `Metric` (an svg-free
 * stat tile) — to keep the transitive dependency surface minimal. The published
 * package bakes its own `$$css` JSX runtime into `dist`, so plain
 * `@vitejs/plugin-react` (no nativewind jsxImportSource) is sufficient.
 *
 * NDA: this consumes `/api/snapshot` JSON only — no protocol bytes, frames, or
 * command codes cross this boundary.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Metric } from '@titan-design/react-ui';
import '@titan-design/react-ui/theme/global.css';

const POLL_INTERVAL_MS = 500;

/** Minimal client-side view of the `/api/snapshot` JSON shape (server: buildSnapshot). */
interface Snapshot {
  session: { sessionId: string; exerciseName?: string } | null;
  devices: Array<{
    slotId: string;
    device: {
      connected: boolean;
      weightLbs?: number;
      trainingMode?: string;
      batteryPercent?: number;
    };
  }>;
  sets: {
    active: {
      reps?: Array<{ repNumber: number; concentric?: { peakVelocity?: number } }>;
      latestInProgress?: { targetWeightTenths?: number };
    } | null;
  };
}

function useSnapshot(): { snapshot: Snapshot | null; error: string | null } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Snapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { snapshot, error };
}

function firstConnectedDevice(snapshot: Snapshot): Snapshot['devices'][number] | undefined {
  return snapshot.devices.find((d) => d.device.connected) ?? snapshot.devices[0];
}

function latestPeakVelocity(snapshot: Snapshot): number | undefined {
  const reps = snapshot.sets.active?.reps;
  if (!reps || reps.length === 0) return undefined;
  return reps[reps.length - 1]?.concentric?.peakVelocity;
}

function fmt(value: number | undefined, digits = 1): string {
  return value === undefined ? '—' : value.toFixed(digits);
}

function App(): React.JSX.Element {
  const { snapshot, error } = useSnapshot();

  const exercise = snapshot?.session?.exerciseName ?? 'No active session';
  const device = snapshot ? firstConnectedDevice(snapshot) : undefined;
  const connected = device?.device.connected ?? false;
  const repCount = snapshot?.sets.active?.reps?.length ?? 0;
  const peakV = snapshot ? latestPeakVelocity(snapshot) : undefined;

  return (
    <div style={{ padding: '32px 24px', maxWidth: 900, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <p
          style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#6B7280' }}
        >
          Phase 0 — react-native-web SPA proof
        </p>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '4px 0' }}>{exercise}</h1>
        <p style={{ fontSize: 13, color: connected ? '#14B8A6' : '#6B7280' }}>
          {connected ? '● device connected' : '○ no device connected'}
          {error ? `  ·  snapshot error: ${error}` : ''}
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
          padding: 24,
          background: '#1A1A1A',
          borderRadius: 12,
          border: '1px solid #2C2C2C',
        }}
      >
        <Metric value={fmt(device?.device.weightLbs)} unit="lbs" label="Weight" size="lg" />
        <Metric value={String(repCount)} label="Reps" size="lg" />
        <Metric
          value={fmt(peakV, 2)}
          unit="m/s"
          label="Peak Velocity"
          size="lg"
          trend={peakV !== undefined ? 'up' : undefined}
        />
        <Metric value={fmt(device?.device.batteryPercent, 0)} unit="%" label="Battery" size="lg" />
      </div>

      <p style={{ marginTop: 16, fontSize: 11, color: '#4B5563' }}>
        Live — polling <code>/api/snapshot</code> every {POLL_INTERVAL_MS}ms. Rendered with{' '}
        <code>@titan-design/react-ui</code> Metric via react-native-web.
      </p>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
