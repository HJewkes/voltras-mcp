// Pure rules behind `npm run changelog:check` (scripts/check-changelog.mjs).
//
// Three things can rot in a hand-written changelog without anyone noticing: the
// version in `package.json` gets bumped and no section is written for it, a
// section is inserted in the wrong place, or a released heading is left with
// nothing under it. Each is checked here; nothing else is. There is no minimum
// entry count, no maximum age and no required-sections list, because a
// changelog policed by a quota collects filler.
//
// `[Unreleased]` being empty is the NORMAL state directly after a release, so
// it is never a finding.

const VERSION_HEADING = /^##\s+\[(?<label>[^\]]+)\](?<rest>.*)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * Every `## [...]` heading, in document order, with the text under it.
 * Headings that are not bracketed (`## Earlier history`) end the previous
 * section and are otherwise ignored.
 */
export function parseSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    const match = VERSION_HEADING.exec(line);
    if (match) {
      current = {
        label: match.groups.label.trim(),
        line: index + 1,
        body: [],
      };
      sections.push(current);
      continue;
    }
    if (line.startsWith('## ')) {
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections.map((section) => ({
    label: section.label,
    line: section.line,
    version: SEMVER.test(section.label) ? section.label : null,
    isUnreleased: section.label.toLowerCase() === 'unreleased',
    body: section.body.join('\n').trim(),
  }));
}

/** Descending-order comparison: positive when `a` should appear above `b`. */
function compareVersions(a, b) {
  const left = SEMVER.exec(a).slice(1, 4).map(Number);
  const right = SEMVER.exec(b).slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function checkVersionIsDocumented(version, sections, findings) {
  if (sections.some((section) => section.version === version)) return;
  findings.push({
    line: null,
    message: `package.json version ${version} has no "## [${version}]" section in CHANGELOG.md`,
  });
}

function checkOrder(sections, findings) {
  const released = sections.filter((section) => section.version !== null);
  for (const [index, section] of released.entries()) {
    const previous = released[index - 1];
    if (!previous) continue;
    const order = compareVersions(previous.version, section.version);
    if (order > 0) continue;
    const reason = order === 0 ? 'duplicates' : 'is newer than';
    findings.push({
      line: section.line,
      message: `version ${section.version} ${reason} ${previous.version} above it; sections run newest first`,
    });
  }
}

function checkUnreleasedIsFirst(sections, findings) {
  const unreleased = sections.findIndex((section) => section.isUnreleased);
  if (unreleased <= 0) return;
  findings.push({
    line: sections[unreleased].line,
    message: '[Unreleased] must be the first section',
  });
}

function checkReleasedSectionsHaveContent(sections, findings) {
  for (const section of sections) {
    if (section.isUnreleased || section.version === null) continue;
    if (section.body !== '') continue;
    findings.push({
      line: section.line,
      message: `released section [${section.version}] is empty`,
    });
  }
}

/** Findings for one changelog; an empty array means it is consistent. */
export function checkChangelog({ version, markdown }) {
  const sections = parseSections(markdown);
  const findings = [];
  checkVersionIsDocumented(version, sections, findings);
  checkUnreleasedIsFirst(sections, findings);
  checkOrder(sections, findings);
  checkReleasedSectionsHaveContent(sections, findings);
  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
