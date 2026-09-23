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

/** A section: heading, the three-line finding, the body, the RP citation. */
export function section(
  title: string,
  finding: readonly string[],
  body: readonly string[],
  citation: string,
): string {
  return [
    `## ${title}`,
    '',
    ...finding.map((line) => `${line}  `),
    '',
    ...body,
    '',
    `**RP.** ${citation}`,
    '',
  ].join('\n');
}
