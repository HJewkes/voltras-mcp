/**
 * The middle value of `values`, averaging the two middle values when the count
 * is even, or `undefined` when there are none.
 *
 * Empty input has no median, so this returns `undefined` rather than a number a
 * caller could mistake for one. Each caller states what it does with an empty
 * input at its own call site.
 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
