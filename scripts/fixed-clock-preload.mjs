// fixed-clock-preload: shift this process's wall clock by `VMCP_CLOCK_OFFSET_MS`.
//
// Loaded into the MCP server with `node --import <this file> dist/bin.js` by
// `scripts/dashboard-body-seed.mjs`, which imports it into itself too, so the
// seeded rows and the server that reads them share one shifted timeline. That
// pins the body page's "Week of" date for the published capture and its CI
// byte baseline (VW-710). Nothing in `src/` changes.
//
// The clock is shifted, not frozen: it keeps ticking from the pinned instant,
// so timers, polls and elapsed-time reads behave exactly as without it. Only
// `Date.now()` and an argument-less `new Date()` move; `performance.now()` and
// an explicit timestamp are untouched. Unset or zero, this file does nothing.

const offsetMs = Number(process.env.VMCP_CLOCK_OFFSET_MS ?? 0);
if (!Number.isFinite(offsetMs)) {
  throw new Error(`VMCP_CLOCK_OFFSET_MS must be a number, got ${process.env.VMCP_CLOCK_OFFSET_MS}`);
}

if (offsetMs !== 0) {
  const RealDate = Date;
  const now = () => RealDate.now() + offsetMs;
  // A function, not a class: `Date()` called without `new` must still return a string.
  function ShiftedDate(...args) {
    if (new.target === undefined) return new RealDate(now()).toString();
    return args.length === 0 ? new RealDate(now()) : new RealDate(...args);
  }
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = now;
  globalThis.Date = ShiftedDate;
}
