# Session-complete page (blind redesign, round 2)

Run: `npm install && npm run dev`, then open http://localhost:5199/?f=2. Use `f=1|2|3` to pick the fixture, add `&units=kg` for kg and `&theme=light` for light.

The app reads `../../fixtures/*.json` in place. Design tokens live in `../tokens.css`.

- `npm run typecheck`: TypeScript, strict.
- `npm run build`: typecheck plus a production build.
- `npm run shoot`: with the dev server running, regenerates `../screens/*.png` (Playwright Chromium).
