// Pure rules behind changelog fragments: one file per pull request under
// `changelog.d/`, folded into CHANGELOG.md at release (VW-704).
//
// A fragment is a markdown file whose front matter names its group and whose
// body is the entry itself:
//
//   ---
//   section: Fixed
//   ---
//
//   - What a user now sees (VW-123, #456).
//
// Two pull requests that each add a fragment touch different paths, so they
// never conflict; two that each edit the same `### Fixed` list always did.

export const FRAGMENT_DIR = 'changelog.d';

/** Keep a Changelog groups, in the order a folded release lists them. */
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const FRAGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const FRONT_MATTER = /^---\n(?<head>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/;
const FIELD = /^(?<key>[A-Za-z]+):\s*(?<value>.*)$/;
const GROUP_HEADING = /^###\s+(?<name>.+?)\s*$/;

/** Files in the fragment directory that are not fragments. */
export const NOT_FRAGMENTS = new Set(['README.md']);

function readFrontMatter(head) {
  const fields = {};
  const problems = [];
  for (const line of head.split('\n')) {
    if (line.trim() === '') continue;
    const match = FIELD.exec(line);
    if (!match) {
      problems.push(`front matter line "${line}" is not "key: value"`);
      continue;
    }
    fields[match.groups.key] = match.groups.value.trim();
  }
  return { fields, problems };
}

function checkFields(fields, problems) {
  for (const key of Object.keys(fields)) {
    if (key !== 'section')
      problems.push(`unknown front matter key "${key}"; only "section" is read`);
  }
  if (fields.section === undefined) {
    problems.push(`front matter needs "section:", one of ${SECTIONS.join(', ')}`);
  } else if (!SECTIONS.includes(fields.section)) {
    problems.push(`section "${fields.section}" is not one of ${SECTIONS.join(', ')}`);
  }
}

function checkBody(body, problems) {
  if (body === '') {
    problems.push('fragment has no entry below its front matter');
    return;
  }
  if (!body.startsWith('- ')) problems.push('the entry must be a list item starting with "- "');
  if (body.split('\n').some((line) => line.startsWith('#'))) {
    problems.push('no headings in a fragment; its section comes from the front matter');
  }
}

/** One fragment's section, entry text and problems; `problems` empty means valid. */
export function parseFragment(name, text) {
  const problems = [];
  if (!FRAGMENT_NAME.test(name)) {
    problems.push('name a fragment after its ticket, such as VW-123.md');
  }
  const match = FRONT_MATTER.exec(text.replace(/\r\n/g, '\n'));
  if (!match) {
    problems.push('fragment must open with front matter: "---", "section: <group>", "---"');
    return { name, section: null, body: '', problems };
  }
  const { fields, problems: fieldProblems } = readFrontMatter(match.groups.head);
  problems.push(...fieldProblems);
  checkFields(fields, problems);
  const body = match.groups.body.trim();
  checkBody(body, problems);
  return { name, section: fields.section ?? null, body, problems };
}

/** Findings for a set of fragments, in the shape `checkChangelog` returns plus `file`. */
export function checkFragments(fragments) {
  return fragments.flatMap((fragment) =>
    fragment.problems.map((message) => ({
      file: `${FRAGMENT_DIR}/${fragment.name}`,
      line: null,
      message,
    })),
  );
}

function unreleasedBounds(lines) {
  const start = lines.findIndex((line) => /^##\s+\[unreleased\]/i.test(line));
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section to fold into');
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return { start, end: next === -1 ? lines.length : next };
}

/** Splits `[Unreleased]` into its loose lead text and its `###` groups, merging repeats. */
function readGroups(bodyLines) {
  const lead = [];
  const groups = new Map();
  let current = lead;
  for (const line of bodyLines) {
    const heading = GROUP_HEADING.exec(line);
    if (heading) {
      const name = heading.groups.name;
      if (!groups.has(name)) groups.set(name, []);
      current = [];
      groups.get(name).push(current);
      continue;
    }
    current.push(line);
  }
  const blocks = new Map(
    [...groups].map(([name, chunks]) => [
      name,
      chunks.map((chunk) => chunk.join('\n').trim()).filter((text) => text !== ''),
    ]),
  );
  return { lead: lead.join('\n').trim(), groups: blocks };
}

function orderedGroupNames(groups) {
  const known = SECTIONS.filter((name) => groups.has(name));
  const other = [...groups.keys()].filter((name) => !SECTIONS.includes(name));
  return [...known, ...other];
}

function addFragments(groups, fragments) {
  const byName = [...fragments].sort((a, b) => a.name.localeCompare(b.name));
  for (const section of [...SECTIONS].reverse()) {
    const entries = byName.filter((fragment) => fragment.section === section);
    if (entries.length === 0) continue;
    groups.set(section, [
      ...entries.map((fragment) => fragment.body),
      ...(groups.get(section) ?? []),
    ]);
  }
}

function renderRelease({ version, date, lead, groups }) {
  const parts = [`## [${version}] - ${date}`];
  if (lead !== '') parts.push(lead);
  for (const name of orderedGroupNames(groups)) {
    const entries = groups.get(name);
    if (entries.length === 0) continue;
    parts.push(`### ${name}`, entries.join('\n\n'));
  }
  return parts.join('\n\n');
}

/**
 * CHANGELOG.md with `[Unreleased]` and every fragment folded into a new
 * `## [version] - date` section below a fresh, empty `[Unreleased]`. Entries
 * already written into `[Unreleased]` keep their place; fragments go on top of
 * their group, because they are the newest.
 */
export function foldFragments({ markdown, fragments, version, date }) {
  const invalid = checkFragments(fragments);
  if (invalid.length > 0) {
    throw new Error(
      `cannot fold invalid fragments:\n${invalid.map((f) => `${f.file}: ${f.message}`).join('\n')}`,
    );
  }
  const lines = markdown.split('\n');
  const { start, end } = unreleasedBounds(lines);
  const { lead, groups } = readGroups(lines.slice(start + 1, end));
  addFragments(groups, fragments);
  if (lead === '' && [...groups.values()].every((entries) => entries.length === 0)) {
    throw new Error('nothing to release: [Unreleased] is empty and there are no fragments');
  }
  const release = renderRelease({ version, date, lead, groups });
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before}\n## [Unreleased]\n\n${release}\n\n${after}`;
}
