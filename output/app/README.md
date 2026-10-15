# Session-complete redesign (round 1)

Run: `npm install && npm run dev`, then open `http://localhost:5173/?fixture=full` (fixtures: `current`, `full`, `edges`; add `&theme=light` or `&units=kg`).

Screenshots: `npm run build && npm run screens` writes every fixture at 1440×900 and 390×844, dark and light, viewport and full scroll, to `../screens/`. Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed.

Layout: `src/types.ts` is the payload contract, `src/fixtures.ts` the three mock sessions, `src/derive.ts` the client-side derivations (Epley e1RM, duration, units, rest), `src/components/` the page.
