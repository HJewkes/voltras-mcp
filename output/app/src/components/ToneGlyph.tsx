import type { Tone } from '../types'
import { TONE_WORD } from '../derive'

interface Props {
  tone: Tone
  size?: number
}

/** Shape carries tone alongside colour: circle-check, triangle-bang, octagon-cross. */
export function ToneGlyph({ tone, size = 20 }: Props) {
  return (
    <svg
      className={`tone-glyph tone-${tone}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={TONE_WORD[tone]}
    >
      {tone === 'ok' && (
        <>
          <circle cx="12" cy="12" r="11" fill="var(--tone-ok-fill)" />
          <path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="var(--ink-inverse)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {tone === 'warn' && (
        <>
          <path d="M12 1.5L23 21.5H1z" fill="var(--tone-warn-fill)" strokeLinejoin="round" />
          <path d="M12 8.5v6" stroke="var(--ink-inverse)" strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="12" cy="18" r="1.6" fill="var(--ink-inverse)" />
        </>
      )}
      {tone === 'alarm' && (
        <>
          <path d="M7.2 1h9.6L23 7.2v9.6L16.8 23H7.2L1 16.8V7.2z" fill="var(--tone-alarm-fill)" />
          <path d="M8 8l8 8M16 8l-8 8" stroke="var(--ink-inverse)" strokeWidth="2.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}
