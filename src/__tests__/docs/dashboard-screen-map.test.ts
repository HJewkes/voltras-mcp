// The capability-to-screen map on the dashboard pages reference (VW-568 S2).
//
// The map answers "I called tool X; where does it show up?", so a row that names
// an unregistered tool, a route the SPA does not route, or a status that
// disagrees with the page's own status table sends a reader somewhere false.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoute } from '../../dashboard/spa/routing.js';
import { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } from '../../tool-registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE = join(REPO_ROOT, 'site/reference/dashboard-pages.md');
const MAP_HEADING = '## Capability to screen';
const TOOL_TOKEN = /^[a-z_]+(\.[a-z_]+)+$|^[a-z_]+\.\*$/;

type Row = Record<string, string>;

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function firstTableAfter(lines: readonly string[], start: number): Row[] {
  const from = lines.findIndex((line, i) => i >= start && line.trim().startsWith('|'));
  const block: string[] = [];
  for (let i = from; i < lines.length && lines[i]!.trim().startsWith('|'); i++)
    block.push(lines[i]!);
  const [header, , ...body] = block.map(cellsOf);
  return body.map((cells) => Object.fromEntries(header!.map((name, i) => [name, cells[i] ?? ''])));
}

function statusWord(cell: string): string {
  return cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
}

function unticked(cell: string): string {
  return cell.replace(/^`|`$/g, '');
}

function mapSection(page: string): string {
  const start = page.indexOf(MAP_HEADING);
  const next = page.indexOf('\n## ', start + MAP_HEADING.length);
  return page.slice(start, next === -1 ? undefined : next);
}

function isRegistered(token: string): boolean {
  const registered: readonly string[] = [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES];
  if (!token.endsWith('.*')) return registered.includes(token);
  const namespace = token.slice(0, -2);
  return registered.some((name) => name.startsWith(`${namespace}.`));
}

const page = readFileSync(PAGE, 'utf8');
const lines = page.split('\n');
const statusTable = firstTableAfter(lines, 0);
const mapRows = firstTableAfter(lines, lines.indexOf(MAP_HEADING));
const statusByRoute = new Map(
  statusTable.map((row) => [unticked(row.Route!), statusWord(row.Status!)]),
);

describe('dashboard capability-to-screen map', () => {
  it('has a row for every route in the status table', () => {
    const mapped = new Set(mapRows.map((row) => unticked(row.Route!)));

    expect([...mapped].sort()).toEqual([...statusByRoute.keys()].sort());
  });

  it('names only routes the SPA routes to a page of their own, or the live page', () => {
    for (const row of mapRows) {
      const route = unticked(row.Route!);

      const parsed = parseRoute(route);

      expect(route === '#/' || parsed.name !== 'live', `${route} falls through to live`).toBe(true);
    }
  });

  it("gives each row the status word the page's own status table gives its route", () => {
    for (const row of mapRows) {
      const route = unticked(row.Route!);

      expect(statusWord(row.Status!), `${row.Screen} (${route})`).toBe(statusByRoute.get(route));
    }
  });

  it('keeps the goals and body screens Coming soon', () => {
    const statusOf = (route: string): string[] =>
      mapRows.filter((row) => unticked(row.Route!) === route).map((row) => statusWord(row.Status!));

    expect(statusOf('#/goals')).toEqual(['Coming soon']);
    expect(statusOf('#/body')).toEqual(['Coming soon']);
  });

  it('names only registered tools anywhere in the section', () => {
    const tokens = [...mapSection(page).matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]!)
      .filter((token) => TOOL_TOKEN.test(token));

    const unregistered = tokens.filter((token) => !isRegistered(token));

    expect(tokens.length).toBeGreaterThan(20);
    expect(unregistered).toEqual([]);
  });
});
