import type { Tone } from '../types';

interface IconProps {
  size?: number;
  className?: string;
}

// Each tone has its own silhouette (circle, triangle, octagon) so the state
// survives greyscale, colour-blindness and a glance from across the room.
export function ToneIcon({ tone, size = 20, className }: IconProps & { tone: Tone }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', className, 'aria-hidden': true };
  if (tone === 'ok') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10.5" fill="currentColor" />
        <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--icon-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tone === 'warn') {
    return (
      <svg {...common}>
        <path d="M12 2.2L23 21.5H1z" fill="currentColor" strokeLinejoin="round" />
        <path d="M12 9v5.5" stroke="var(--icon-ink)" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="12" cy="18" r="1.5" fill="var(--icon-ink)" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M8 1.5h8l6.5 6.5v8L16 22.5H8L1.5 16V8z" fill="currentColor" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--icon-ink)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function DeltaIcon({ delta, size = 28, className }: IconProps & { delta: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className,
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (delta > 0) return <svg {...common}><path d="M12 20V4M5 11l7-7 7 7" /></svg>;
  if (delta < 0) return <svg {...common}><path d="M12 4v16M5 13l7 7 7-7" /></svg>;
  return <svg {...common}><path d="M5 9h14M5 15h14" /></svg>;
}

export function FlagIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}

export function LockIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </svg>
  );
}

const NAV_PATHS: Record<string, string> = {
  Live: 'M12 12m-3 0a3 3 0 106 0a3 3 0 10-6 0M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8',
  Review: 'M4 4h16v16H4zM8 12l3 3 5-6',
  Plan: 'M4 6h16M4 12h16M4 18h10',
  Goals: 'M12 12m-8 0a8 8 0 1016 0a8 8 0 10-16 0M12 12m-3.5 0a3.5 3.5 0 107 0a3.5 3.5 0 10-7 0',
  'Check-in': 'M5 12l4 4 10-10M5 20h14',
  Body: 'M12 5m-2.5 0a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0M6 10h12M12 10v5M9 21l3-6 3 6',
};

export function NavIcon({ name, size = 24 }: IconProps & { name: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_PATHS[name]} />
    </svg>
  );
}
