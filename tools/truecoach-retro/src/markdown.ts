// Markdown table and number formatting for the report.

export function table(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

export function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(0)}%`;
}

export function signed(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** A section: heading, an optional opening paragraph, the three-line finding, the body, the RP citation. */
export function section(
  title: string,
  finding: readonly string[],
  body: readonly string[],
  citation: string,
  opening: string | null = null,
): string {
  return [
    `## ${title}`,
    '',
    ...(opening === null ? [] : [opening, '']),
    ...finding.map((line) => `${line}  `),
    '',
    ...body,
    '',
    `**RP.** ${citation}`,
    '',
  ].join('\n');
}

/** One headline number of a check, already formatted: `[what, value]`. */
export type Figure = readonly [string, string];

/** A check's figures twice, all weeks against regular weeks only, matched by label. */
export function comparisonTable(all: readonly Figure[], regular: readonly Figure[]): string {
  const regularByLabel = new Map(regular);
  const labels = [...new Set([...all.map(([label]) => label), ...regular.map(([label]) => label)])];
  const allByLabel = new Map(all);
  return table(
    ['figure', 'all weeks', 'regular weeks only'],
    labels.map((label) => [
      label,
      allByLabel.get(label) ?? 'n/a',
      regularByLabel.get(label) ?? 'n/a',
    ]),
  );
}

/** The comparison block a check appends to its body; empty when there is no regular context. */
export function comparisonBlock(
  all: readonly Figure[],
  regular: readonly Figure[] | null,
  note: string | null = null,
): string[] {
  if (regular === null) return [];
  const intro = note === null ? [] : [note, ''];
  return ['', ...intro, 'All weeks against regular weeks only:', '', comparisonTable(all, regular)];
}
