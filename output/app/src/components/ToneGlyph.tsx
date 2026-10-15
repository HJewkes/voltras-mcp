import type { Tone } from "../types";

const TONE_WORD: Record<Tone | "none", string> = {
  ok: "OK",
  warn: "Warning",
  alarm: "Alarm",
  none: "No reading",
};

/** Shape carries the tone as well as colour: circle-check, triangle, octagon, dashed ring. */
export function ToneGlyph({ tone, size = "1em" }: { tone: Tone | "none"; size?: string }) {
  return (
    <svg
      className={`glyph glyph--${tone}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={TONE_WORD[tone]}
    >
      {SHAPES[tone]}
    </svg>
  );
}

const SHAPES: Record<Tone | "none", JSX.Element> = {
  ok: (
    <>
      <circle cx="12" cy="12" r="10.5" fill="currentColor" />
      <path d="M7 12.5l3.3 3.3L17.2 9" fill="none" stroke="var(--surface-1)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  warn: (
    <>
      <path d="M12 1.8L23 21.5H1z" fill="currentColor" strokeLinejoin="round" />
      <path d="M12 8.5v6.5" stroke="var(--surface-1)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="12" cy="18.2" r="1.5" fill="var(--surface-1)" />
    </>
  ),
  alarm: (
    <>
      <path d="M7.4 1.5h9.2l6.4 6.4v8.2l-6.4 6.4H7.4L1 16.1V7.9z" fill="currentColor" />
      <path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke="var(--surface-1)" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  none: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3.2 2.6" />
      <path d="M8 12h8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
};
