// The published capability reference is generated, not typed — this is what
// keeps it that way. It runs `scripts/gen-tool-reference.mjs` into throwaway
// directories and fails when the checked-in pages differ, so adding a tool
// without regenerating turns the `test` job red rather than shipping a page
// that quietly omits it.
//
// It also runs the generator TWICE, because "generated" is only useful if the
// same registry yields the same bytes; and it re-runs the protocol guard over
// the freshly generated pages, because this site is public and the device
// protocol was shared with us in confidence.
//
// Content assertions read the FRESH output, not the checked-in copy: an
// assertion against a committed page cannot catch a renderer that has just
// started rendering it wrong.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProtocolTokens } from '../../docs/protocol-guard.js';
import { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } from '../../tool-registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATOR = join(REPO_ROOT, 'scripts/gen-tool-reference.mjs');
const SITE_DIR = join(REPO_ROOT, 'site');

// The generator builds `dist` when it is missing or stale — that dominates the
// wall clock on a fresh checkout, and CI's `test` job never runs `npm run build`.
const GENERATE_TIMEOUT_MS = 240_000;

interface GeneratorReport {
  readonly pageCount: number;
  readonly coreToolCount: number;
  readonly mockToolCount: number;
  readonly redactions: Record<string, number>;
  readonly isolation: Record<string, string>;
}

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

function generateInto(outDir: string): GeneratorReport {
  const reportPath = join(mkdtempSync(join(tmpdir(), 'vmcp-ref-report-')), 'report.json');
  const result = spawnSync(process.execPath, [GENERATOR, '--out', outDir, '--report', reportPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`gen-tool-reference.mjs failed:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(readFileSync(reportPath, 'utf8')) as GeneratorReport;
}

/** The `## \`name\`` block for one tool, up to the next tool heading. */
function sectionFor(markdown: string, toolName: string): string {
  const start = markdown.indexOf(`## \`${toolName}\`\n`);
  expect(start, `${toolName} has no section on its namespace page`).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf('\n## ', start + 1);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

let firstRun: string;
let secondRun: string;
let report: GeneratorReport;
const generated: string[] = [];

beforeAll(() => {
  firstRun = mkdtempSync(join(tmpdir(), 'vmcp-ref-a-'));
  secondRun = mkdtempSync(join(tmpdir(), 'vmcp-ref-b-'));
  report = generateInto(firstRun);
  generateInto(secondRun);
  generated.push(...listFiles(firstRun));
}, GENERATE_TIMEOUT_MS);

afterAll(() => {
  for (const dir of [firstRun, secondRun]) rmSync(dir, { recursive: true, force: true });
});

describe('generated capability reference', () => {
  it('emits every page the site has checked in, and no others', () => {
    // Only the generated roots, so a `.vitepress/dist` from a local docs build
    // never counts as a checked-in page.
    const checkedIn = [
      ...listFiles(join(SITE_DIR, 'reference')).map((file) => join('reference', file)),
      join('.vitepress', 'reference-sidebar.json'),
    ].sort();
    expect(generated).toEqual(checkedIn);
  });

  it('reproduces the checked-in pages byte for byte', () => {
    const stale: string[] = [];
    for (const file of generated) {
      const fresh = readFileSync(join(firstRun, file), 'utf8');
      if (fresh !== readFileSync(join(SITE_DIR, file), 'utf8')) stale.push(file);
    }
    expect(stale, 'run `npm run docs:reference` and commit the result').toEqual([]);
  });

  it('produces identical bytes on a second run with no source change', () => {
    const drifted = generated.filter(
      (file) =>
        readFileSync(join(firstRun, file), 'utf8') !== readFileSync(join(secondRun, file), 'utf8'),
    );
    expect(drifted, 'the generator is not deterministic').toEqual([]);
  });

  it('writes one page per namespace plus the index, resources and push events', () => {
    const namespaces = new Set(
      [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES].map((n) => n.split('.')[0]),
    );
    expect(report.pageCount).toBe(namespaces.size + 3);
  });
});

describe('confidentiality boundary', () => {
  it('publishes no byte literal, opcode, offset or register name', () => {
    const offenders: string[] = [];
    for (const file of generated) {
      for (const match of findProtocolTokens(readFileSync(join(firstRun, file), 'utf8'))) {
        offenders.push(`${file}: ${match.kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Pinned on purpose: these four descriptions name device internals, so the
  // generator strips them. A change here means a description gained or lost
  // protocol detail — read the diff before updating the numbers.
  it('redacts protocol detail out of the descriptions that carry it', () => {
    expect(report.redactions).toEqual({
      'device.unload': 2,
      'device.start_guided_load': 2,
      'device.exit_guided_load': 1,
      'device.start_row': 1,
    });
  });

  it('boots the server against an isolated store and no dashboard', () => {
    expect(report.isolation.VOLTRA_ADAPTER).toBe('mock');
    expect(report.isolation.VMCP_DASHBOARD_PORT).toBe('off');
    expect(report.isolation.VMCP_DB_PATH).not.toContain('.voltras');
    expect(report.isolation.VMCP_SLOT_BINDINGS_PATH).not.toContain('.voltras');
  });
});

describe('badges', () => {
  const devicePage = (): string => readFileSync(join(firstRun, 'reference/device.md'), 'utf8');

  it('marks the five superseded isokinetic setters deprecated', () => {
    const deprecated = [
      'device.set_isokinetic_target_speed',
      'device.set_isokinetic_ecc_mode',
      'device.set_isokinetic_ecc_speed_limit',
      'device.set_isokinetic_ecc_const_weight',
      'device.set_isokinetic_ecc_overload_weight',
    ];
    const page = devicePage();
    for (const name of deprecated) {
      expect(sectionFor(page, name), name).toContain('text="deprecated"');
    }
  });

  // `device.set_eccentric` carries a deprecated PARAMETER (`percent`), not a
  // deprecated tool. Prose matching on the word would mark the tool itself.
  it('does not mark a tool deprecated for carrying a deprecated parameter', () => {
    const section = sectionFor(devicePage(), 'device.set_eccentric');
    expect(section).toContain('deprecated alias');
    expect(section).not.toContain('text="deprecated"');
  });

  it('marks the two experimental guided-load tools', () => {
    const page = devicePage();
    for (const name of ['device.start_guided_load', 'device.exit_guided_load']) {
      expect(sectionFor(page, name), name).toContain('text="experimental"');
    }
  });

  it('marks every mock-only tool as mock-only', () => {
    const page = readFileSync(join(firstRun, 'reference/mock.md'), 'utf8');
    for (const name of MOCK_TOOL_NAMES) {
      expect(sectionFor(page, name), name).toContain('text="mock adapter only"');
    }
  });
});

describe('derived counts', () => {
  it("reports the registry's own counts rather than a literal", () => {
    expect(report.coreToolCount).toBe(CORE_TOOL_NAMES.length);
    expect(report.mockToolCount).toBe(MOCK_TOOL_NAMES.length);
  });

  it('prints both counts on the index page', () => {
    const index = readFileSync(join(firstRun, 'reference/index.md'), 'utf8');
    expect(index).toContain(`**${CORE_TOOL_NAMES.length} tools**`);
    expect(index).toContain(`**${CORE_TOOL_NAMES.length + MOCK_TOOL_NAMES.length}**`);
  });
});
