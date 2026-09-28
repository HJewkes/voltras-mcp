// Holds the dashboard-first front door (VW-568 S1) to what the code does.
//
// The home page must lead with the dashboard without advertising a Coming soon
// screen, and the setup page's port, health fields and launcher rule must be the
// ones the server and the plugin launcher actually implement.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DASHBOARD_PORT } from '../../dashboard/server.js';

const REPO_ROOT = new URL('../../../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, REPO_ROOT), 'utf8');
}

function frontmatter(text: string): string {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (block === null) throw new Error('page has no frontmatter');
  return block[1] as string;
}

/** The items of a YAML block list under `key`, each as its raw lines joined. */
function listItems(yaml: string, key: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const keyIndent = (lines[start] as string).search(/\S/);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= keyIndent) break;
    if (line.trim().startsWith('- ')) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }
  return items;
}

function linkOf(item: string): string {
  return /link:\s*(\S+)/.exec(item)?.[1] ?? '';
}

const COMING_SOON_TARGET = /\/coming-soon\/|#\/goals|#\/body/;

describe('the home page leads with the dashboard', () => {
  const home = read('site/index.md');
  const yaml = frontmatter(home);
  const actions = listItems(yaml, 'actions');
  const features = listItems(yaml, 'features');

  it('makes the first alternative hero action open the dashboard overview', () => {
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[1]).toMatch(/theme:\s*alt/);
    expect(linkOf(actions[1] as string)).toBe('/guides/dashboard');
  });

  it('points the first feature card at the dashboard overview', () => {
    expect(linkOf(features[0] as string)).toBe('/guides/dashboard');
  });

  it('links at least two of the four feature cards into dashboard pages', () => {
    const dashboardCards = features.filter((item) => linkOf(item).startsWith('/guides/dashboard'));
    expect(features).toHaveLength(4);
    expect(dashboardCards.length).toBeGreaterThanOrEqual(2);
  });

  it('embeds the live page mid-set capture', () => {
    expect(home).toContain('](/captures/live-mid-set.png)');
  });

  it('never sends a hero action or a feature card to a Coming soon screen', () => {
    for (const item of [...actions, ...features]) {
      expect(linkOf(item)).not.toMatch(COMING_SOON_TARGET);
      expect(item.toLowerCase()).not.toContain('coming soon');
    }
  });
});

describe('the setup page matches the server and the launcher', () => {
  const setup = read('site/guides/dashboard-setup.md');

  it('names the port the dashboard binds by default', () => {
    const named = /The default port is `(\d+)`/.exec(setup)?.[1];
    expect(Number(named)).toBe(DEFAULT_DASHBOARD_PORT);
  });

  it('cites only health fields that server.health returns', () => {
    const healthSource = read('src/tools/server-tools.ts');
    const cited = new Set(setup.match(/\bdashboard[A-Z]\w+/g) ?? []);
    expect([...cited].sort()).toEqual(
      ['dashboardAvailable', 'dashboardDisabledReason', 'dashboardUrl'].sort(),
    );
    for (const field of cited) expect(healthSource).toContain(`${field}:`);
  });

  it('describes the launcher rule the launcher still implements', () => {
    const launcher = read('plugins/voltras-channel/bin/voltras-mcp-launch.sh');
    const voltraPt = read('scripts/voltra-pt');
    expect(setup).toContain('`VMCP_DASHBOARD_PORT=off`');
    expect(setup).toContain('`VOLTRA_PT=1`');
    expect(launcher).toContain('[ "${VOLTRA_PT:-0}" != "1" ]');
    expect(launcher).toContain('export VMCP_DASHBOARD_PORT=off');
    expect(voltraPt).toContain('export VOLTRA_PT=1');
  });
});

describe('the sidebar gives the dashboard its own group', () => {
  const config = read('site/.vitepress/config.mts');
  const groups = [...config.matchAll(/^ {8}text: '([^']+)',$/gm)].map((match) => match[1]);

  it('places "The dashboard" directly after Get started', () => {
    expect(groups.indexOf('The dashboard')).toBe(groups.indexOf('Get started') + 1);
  });

  it('links only pages that exist', () => {
    const start = config.indexOf("text: 'The dashboard'");
    const block = config.slice(start, config.indexOf('],', start));
    const links = [...block.matchAll(/link: '([^']+)'/g)].map((match) => match[1] as string);
    expect(links).toContain('/guides/dashboard-setup');
    for (const link of links) expect(existsSync(new URL(`site${link}.md`, REPO_ROOT))).toBe(true);
  });
});

describe('the guides index lists every dashboard tour', () => {
  it('links every site/guides/dashboard*.md page', () => {
    const guidesIndex = read('site/guides/index.md');
    const tourFiles = readdirSync(new URL('site/guides/', REPO_ROOT)).filter((name) =>
      /^dashboard.*\.md$/.test(name),
    );
    expect(tourFiles.length).toBeGreaterThan(0);
    for (const file of tourFiles) {
      const slug = file.replace(/\.md$/, '');
      expect(guidesIndex).toContain(`/guides/${slug}`);
    }
  });
});
