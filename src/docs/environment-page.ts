// Renders the environment-variables reference page from the checked-in list
// in `environment-variables.ts`. Pure, like the rest of the reference.

import type { EnvironmentVariable } from './environment-variables.js';
import type { ProtocolGuard } from './protocol-guard.js';

const SOURCE_URL = 'https://github.com/HJewkes/voltras-mcp/blob/main';

function row(variable: EnvironmentVariable): string {
  const source = `[${variable.source}](${SOURCE_URL}/${variable.source})`;
  return [
    `\`${variable.name}\``,
    variable.defaultValue,
    variable.accepts,
    variable.onInvalid,
    variable.purpose,
    source,
  ].join(' | ');
}

function sectionsOf(variables: readonly EnvironmentVariable[]): Map<string, EnvironmentVariable[]> {
  const sections = new Map<string, EnvironmentVariable[]>();
  for (const variable of variables) {
    const existing = sections.get(variable.section);
    if (existing) existing.push(variable);
    else sections.set(variable.section, [variable]);
  }
  return sections;
}

/**
 * The page body. Every row goes through the guard and any hit is reported by
 * variable name, so the caller can fail the build instead of publishing it.
 */
export function renderEnvironmentPage(
  banner: string,
  variables: readonly EnvironmentVariable[],
  guard: ProtocolGuard,
  findings: string[],
): string {
  const lines = [
    banner,
    '',
    '# Environment variables',
    '',
    'Every variable is optional: the defaults are a working configuration. The server reads',
    'them once at startup. "If invalid" says what happens to a value it does not accept.',
    'The list is checked against the code by a docs test, so a variable the server reads',
    'cannot be missing here.',
  ];
  for (const [section, members] of sectionsOf(variables)) {
    lines.push('', `## ${section}`, '');
    lines.push('| Variable | Default | Accepts | If invalid | Purpose | Read in |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const variable of members) {
      const text = `| ${row(variable)} |`;
      for (const match of guard.find(text))
        findings.push(`environment variable ${variable.name}: ${match.kind}`);
      lines.push(text);
    }
  }
  lines.push('');
  return lines.join('\n');
}
