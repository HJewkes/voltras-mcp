# Session-complete prototype

Run: `npm install && npm run dev`, then open `http://localhost:5173/?f=2` (`f` = 1, 2 or 3; add `&unit=kg` or `&theme=light`).

- `npm test`: derivation tests against the three fixtures.
- `npm run build && npx vite preview` then `npm run screens -- http://localhost:4173/ ../screens` regenerates `output/screens/` (uses Playwright's Chromium).

Fixtures are read from `../../fixtures/` and tokens from `../tokens.css`; nothing else on this branch is needed.
