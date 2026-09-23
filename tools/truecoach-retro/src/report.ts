// The report: a data summary, the six checks in the approved order, and the two closing sections.

import { adherenceSection } from './checks/adherence.js';
import { bodyweightSection } from './checks/bodyweight.js';
import { deloadSection } from './checks/deload.js';
import { rampSection, restartSection, stalenessSection } from './checks/meso-reviews.js';
import { missedSection } from './checks/missed.js';
import { progressionSection } from './checks/progression.js';
import { segmentContext, segmentsSection } from './checks/segments.js';
import { volumeSection } from './checks/volume.js';
import type { Context } from './context.js';
import { isWorkRow, LOW_CONFIDENCE } from './log-rules.js';
import { pct, table } from './markdown.js';

function dataSummary(ctx: Context): string {
  const work = ctx.rows.filter(isWorkRow);
  const unmapped = work.filter((row) => !ctx.lookup.isMapped(row.exercise_name));
  const unmappedNames = new Set(unmapped.map((row) => row.exercise_name ?? '(no name)'));
  const rows: [string, string | number][] = [
    ['set rows', ctx.rows.length],
    ['work rows (not above a warm-up divider)', work.length],
    [
      'work rows with no divider (is_warmup null), read as work',
      work.filter((r) => r.is_warmup === null).length,
    ],
    [
      'rows under 0.6 confidence, included',
      ctx.rows.filter((r) => r.confidence < LOW_CONFIDENCE).length,
    ],
    ['rows stating more than one set', ctx.rows.filter((r) => r.sets > 1).length],
    ['work sets (sum of the sets field)', work.reduce((sum, r) => sum + r.sets, 0)],
    ['training days', `${ctx.days.length}, ${ctx.days[0] ?? ''} to ${ctx.days.at(-1) ?? ''}`],
    [
      'work rows with no mapped muscle',
      `${unmapped.length} (${pct(unmapped.length, work.length)}), ${unmappedNames.size} names`,
    ],
    [
      'main lifts (map main_lift)',
      ctx.mainLifts.map((l) => `${l.series.label} (${l.family})`).join(', '),
    ],
  ];
  return ['## The data', '', table(['what', 'count'], rows), ''].join('\n');
}

const CANNOT_TELL = [
  '## What this cannot tell us',
  '',
  '- Effort. There is no RIR or RPE field, so a hit at RPE 6 and a grinding hit read the same, and no check can see the within-meso effort ramp RP expects.',
  '- Fatigue as the live system means it. Velocity loss, ROM drift and rep speed do not exist in an email log; the missed-target runs are a proxy, and a coach who prescribed conservatively would hide real fatigue from it.',
  "- Whether a boundary was a planned deload, from the log alone. The meso rule sees load drops and gaps, not intent, so it reads the human's marks (`--boundary-decisions`).",
  '- Warm-ups in undivided blocks. Rows with no divider are counted as work, which inflates weekly sets for those blocks.',
  '- Individual landmarks. MEV and MRV are population defaults; RP finds MRV by performance, not set counts.',
  '- Waist meaning. It is reported against bodyweight only; the RP corpus has no rule for it.',
  '- The tier self-report half: years training, earlier breaks, earlier plateaus.',
  '',
];

const NEXT_CHECKS = [
  '## Suggested next checks',
  '',
  '- Underperformance against the previous session at matched load, alongside the missed-prescription proxy, to see where the two disagree.',
  '- RPE note lines: attach the stated RPE to its block and look for rising RPE at the same load.',
  '',
];

export function renderReport(ctx: Context, generatedOn: string): string {
  const segmented = segmentContext(ctx);
  const { regular } = segmented;
  return [
    '# TrueCoach retrospective, first pass (VW-546), with regular and broken weeks (VW-548)',
    '',
    `Generated ${generatedOn} by \`voltras-mcp/tools/truecoach-retro\`. Loads read as lb. Checks run in the order the human approved; checks 1, 2, 3 and 5 end with their figures for all weeks against regular weeks only (VW-548).`,
    '',
    dataSummary(ctx),
    segmentsSection(ctx, segmented),
    progressionSection(ctx, regular),
    missedSection(ctx, regular),
    volumeSection(ctx, regular),
    deloadSection(ctx),
    adherenceSection(ctx, regular),
    bodyweightSection(ctx),
    restartSection(ctx),
    rampSection(ctx),
    stalenessSection(ctx),
    ...CANNOT_TELL,
    ...NEXT_CHECKS,
  ].join('\n');
}
