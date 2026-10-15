// Pure rule behind `npm run check:nul-bytes` (scripts/check-nul-bytes.mjs).
//
// A literal NUL byte in a tracked text file makes `grep -r` (no `-a` /
// `--binary-files=text`) classify the file as binary and skip it silently, so
// every content sweep that relies on plain `grep -r` walks straight past it
// (VW-213, VW-223). This check reads the raw bytes directly, so it sees a NUL
// the same way a sweep script fails to.

/**
 * @param {{ path: string, buffer: Buffer }[]} files
 * @returns {{ path: string, offset: number }[]}
 */
export function findNulByteFiles(files) {
  const findings = [];
  for (const { path, buffer } of files) {
    const offset = buffer.indexOf(0);
    if (offset !== -1) {
      findings.push({ path, offset });
    }
  }
  return findings;
}
