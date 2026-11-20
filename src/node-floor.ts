// First release with node:sqlite available without a flag.
const FLOOR = { major: 22, minor: 13 } as const;

export function nodeFloorProblem(version: string): string | null {
  const [major = 0, minor = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const tooOld = major < FLOOR.major || (major === FLOOR.major && minor < FLOOR.minor);
  return tooOld
    ? `voltras-mcp needs Node 22.13 or later (found ${version}). Install Node 22.13 or later and run it again.`
    : null;
}
