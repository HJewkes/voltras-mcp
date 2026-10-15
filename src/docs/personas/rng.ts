// The seeded generator behind every persona, ported from the adaptive-rest
// simulation so a persona's velocities match the sim's for the same seed. A seed
// fixes the whole store: no persona reads Math.random or the wall clock.

/** A seeded uniform generator on [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast and reproducible across platforms. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw, Box-Muller, from a seeded uniform. */
export function gaussian(rng: Rng): number {
  const u = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** One of `options`, drawn uniformly. */
export function pick<T>(rng: Rng, options: readonly [T, ...T[]]): T {
  return options[Math.floor(rng() * options.length)] ?? options[0];
}
