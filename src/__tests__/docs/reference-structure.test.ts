// The data the capability reference is laid out from (VMCP-07.08): the domain
// groups, the per-tool status map and the environment-variable list. Each is
// checked against the code it describes, so none of them can name something
// that is not there or leave out something that is.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_VARIABLES } from '../../docs/environment-variables.js';
import { createProtocolGuard } from '../../docs/protocol-guard.js';
import {
  buildReference,
  type SidebarGroup,
  type SidebarItem,
  type ToolStatusNote,
} from '../../docs/reference-pages.js';
import { OTHER_GROUP, REFERENCE_GROUPS } from '../../docs/reference-groups.js';
import { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } from '../../tool-registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readToolStatus(): Record<string, ToolStatusNote> {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'src/docs/tool-status.json'), 'utf8')) as Record<
    string,
    ToolStatusNote
  >;
}

function referenceFor(coreToolNames: readonly string[]): ReturnType<typeof buildReference> {
  return buildReference({
    guard: createProtocolGuard(coreToolNames),
    toolStatus: {},
    environmentVariables: [],
    coreToolNames,
    mockToolNames: [],
    tools: coreToolNames.map((name) => ({ name, description: 'Does a thing.' })),
    resources: [],
    resourceTemplates: [],
    pushEvents: [],
  });
}

function isGroup(item: SidebarItem): item is SidebarGroup {
  return 'items' in item;
}

describe('the tool status map', () => {
  it('names only tools the registry registers', () => {
    const registered = new Set([...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES]);
    const unknown = Object.keys(readToolStatus()).filter((name) => !registered.has(name));
    expect(unknown, 'src/docs/tool-status.json names tools the registry does not have').toEqual([]);
  });

  it('links every entry to a page that exists', () => {
    const missing = Object.entries(readToolStatus())
      .map(([name, status]) => ({ name, page: `site${status.link.split('#')[0] ?? ''}.md` }))
      .filter(({ page }) => !existsSync(join(REPO_ROOT, page)));
    expect(missing).toEqual([]);
  });
});

describe('the reference sidebar', () => {
  it('lays the namespaces out in collapsed domain groups, in table order', () => {
    const { sidebar } = referenceFor(['plan.a', 'device.b', 'session.c']);
    const groups = sidebar.filter(isGroup);
    expect(groups.map((group) => group.text)).toEqual([
      'Device and rig',
      'Recording',
      'Planning and goals',
    ]);
    expect(groups.every((group) => group.collapsed)).toBe(true);
  });

  it('files an unmapped namespace under Other and reports it', () => {
    const reference = referenceFor(['device.b', 'brand_new.thing']);
    const other = reference.sidebar.filter(isGroup).find((group) => group.text === OTHER_GROUP);
    expect(other?.items).toEqual([{ text: 'brand_new.*', link: '/reference/brand_new' }]);
    expect(reference.unmappedNamespaces).toEqual(['brand_new']);
  });

  it('maps every namespace the registry registers today', () => {
    const mapped = new Set(REFERENCE_GROUPS.flatMap((group) => group.namespaces));
    const namespaces = new Set(
      [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES].map((n) => n.split('.')[0]),
    );
    expect([...namespaces].filter((namespace) => !mapped.has(namespace as string))).toEqual([]);
  });

  it('ends with the resource, event, environment and dashboard pages', () => {
    const { sidebar } = referenceFor(['device.b']);
    expect(sidebar.slice(-5).map((item) => item.text)).toEqual([
      'Resources',
      'Push events',
      'Environment variables',
      'Dashboard pages',
      'Dashboard API',
    ]);
  });
});

/** Every `VMCP_*` / `VOLTRA*` name the server reads from `env`, outside tests. */
function environmentReads(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'spa') environmentReads(full, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const source = readFileSync(full, 'utf8');
    for (const match of source.matchAll(/\benv\.((?:VMCP|VOLTRA)[A-Z0-9_]*)/g)) {
      found.add(match[1] as string);
    }
  }
  return found;
}

describe('the environment-variable list', () => {
  const documented = new Set(ENVIRONMENT_VARIABLES.map((variable) => variable.name));
  const read = environmentReads(join(REPO_ROOT, 'src'));

  it('documents every variable the server reads', () => {
    expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });

  it('documents no variable the server does not read', () => {
    expect([...documented].filter((name) => !read.has(name)).sort()).toEqual([]);
  });

  it('points every row at a file that exists', () => {
    const missing = ENVIRONMENT_VARIABLES.filter(
      (variable) => !existsSync(join(REPO_ROOT, variable.source)),
    );
    expect(missing.map((variable) => variable.name)).toEqual([]);
  });
});
