import { describe, expect, it } from 'vitest'
import current from '../../../../fixtures/1-current.json'
import full from '../../../../fixtures/2-full-session.json'
import edges from '../../../../fixtures/3-edges.json'
import type { SessionSummary } from '../types'
import { agreementOf, scoreAgainstTarget, sessionTotals, strengthTrend } from '../derive'
import { formatDelta, formatSetLoad } from '../format'

const one = current as SessionSummary
const two = full as SessionSummary
const three = edges as SessionSummary
const byName = (s: SessionSummary, name: string) => s.exercises.find((e) => e.name === name)!

describe('verdict versus progression', () => {
  it('flags a good verdict next to a back-off as a disagreement', () => {
    expect(agreementOf(one.exercises[0])).toBe('speed-fine-reps-short')
  })

  it('treats a grinding verdict with a back-off as agreement', () => {
    expect(agreementOf(byName(two, 'Standing Cable Chest Press'))).toBe('agree')
  })

  it('has nothing to compare when progression is null', () => {
    expect(agreementOf(byName(two, 'Face Pull'))).toBeNull()
  })
})

describe('rep scoring mirrors the server count', () => {
  it('skips working sets with no load, matching the server "1/1 sets"', () => {
    const scored = scoreAgainstTarget(byName(three, 'Cable Biceps Curl'))
    expect(scored.map((s) => s.outcome)).toEqual(['in'])
  })

  it('marks reps under the target low end as below', () => {
    const scored = scoreAgainstTarget(byName(two, 'Standing Cable Chest Press'))
    expect(scored.map((s) => s.outcome)).toEqual(['in', 'below', 'below'])
  })
})

describe('units', () => {
  it('shows the kg change that matches the rounded loads on screen', () => {
    const row = byName(two, 'Seated Cable Row').progression!
    expect(formatDelta(row, 'kg')).toBe('+3 kg')
    expect(formatDelta(row, 'lb')).toBe('+5 lb')
  })

  it('keeps non-weight load labels verbatim in kg mode', () => {
    const damper = byName(two, 'Face Pull').sets[0]
    expect(formatSetLoad(damper, 'kg')).toBe('damper 6')
  })
})

describe('honest gaps', () => {
  it('reports strength loss across working sets from Epley e1RM', () => {
    const trend = strengthTrend(byName(two, 'Cable Romanian Deadlift'))!
    expect(Math.round(trend.first)).toBe(168)
    expect(Math.round(trend.last)).toBe(160)
  })

  it('has no strength trend when no set recorded a load', () => {
    expect(strengthTrend(byName(two, 'Face Pull'))).toBeNull()
  })

  it('lists unloaded sets instead of counting them as zero volume', () => {
    expect(sessionTotals(two).unloadedSetLabels).toEqual(['damper 6', 'damper 6'])
    expect(sessionTotals(two).volumeLbs).toBe(12160)
  })
})
