# Contributing

Thanks for looking at `voltras-mcp`. This is a small side project, not a
funded team, so response times will vary — but contributions are welcome.

## Before you start

- Branch off `main` with a `feat/`, `fix/`, `refactor/`, or `docs/` prefix.
- Changes to `site/**` (the docs site) have their own additional rule; see
  [`site/CONTRIBUTING-DOCS.md`](site/CONTRIBUTING-DOCS.md).
- Most work does not need a physical device. Set `VOLTRA_ADAPTER=mock` to run
  against an in-memory device with deterministic frames — the same mode CI
  and most local dev use.

## Gates a change must pass

These are exactly the jobs `.github/workflows/ci.yml` runs, so you can
reproduce CI locally:

```bash
npm run lint          # ESLint, includes the confidentiality guard below
npm run format:check  # Prettier — src/**, scripts/**, eslint-rules/** only
npm run typecheck     # tsc --noEmit (+ dashboard SPA + test sources)
npm test              # Vitest
npm run build         # emits dist/, then verifies dist/bin.js and dist/server.js exist
```

`npm run format:check` does **not** cover Markdown or `site/**`. Markdown
formatting is instead handled by the `lint-staged` pre-commit hook and by
`.husky/pre-push`, which runs `prettier --check` over files changed against
`origin/main` under `src/**`, `scripts/**`, or `site/**` markdown. If your
change is Markdown-only outside those paths, no automated formatting gate
runs on it — keep it readable by eye.

If your change touches hardware behavior (device modes, framing, live
metrics) and you don't have a Voltra to test against, say so explicitly in
the PR. A hardware-dependent change that a contributor could not verify
locally is normal here; hiding that is the only way it becomes a problem.

## The confidentiality boundary

Beyond Power shared this device's internals informally to help the community
SDK, on the understanding that the details wouldn't be shared publicly. That
is a **confidentiality boundary** — a trust commitment, not a signed
agreement. Please don't write "NDA" anywhere in this repo; nothing was
signed, and the wording matters.

**The rule:** no device value, byte, frame payload, command code, register
name, offset, or path into a non-public tree may appear in source, comments
(including trailing ones), string literals, identifiers, tool inputs,
outputs, schemas, descriptions, log lines, error messages, commit messages,
or PR titles/bodies. Describe the observable _behavior_ instead — what the
device does, in plain words and ordinary units, not what byte causes it.

**What enforces this, and what doesn't:**

| layer                                          | covers                                                                                                                    | runs                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `voltras/no-protocol-detail` (`eslint-rules/`) | encoded values and provenance in `src/**`: hex literals, byte sequences, bare hex runs, command codes, private-tree paths | `npm run lint`, CI                       |
| NF-07 (`eslint.config.mjs`)                    | `Buffer.*` inside any `*Handler` function                                                                                 | `npm run lint`, CI                       |
| `src/docs/protocol-guard.ts`                   | protocol-shaped tokens on generated documentation pages                                                                   | `npm run docs:reference`, `npm test`, CI |

The docs site (everything under `site/`) is **not covered by any of
these** — the published docs are guarded by human review alone. A sentence
that names a register and describes what writing to it does carries no
value in any shape a pattern can match. If you're writing or editing a docs
page, read what you're adding and ask whether a reader could reconstruct
protocol detail from it, the same way you'd review for a leaked secret.

**A known limit of the ESLint rule:** it cannot see a value split across a
string concatenation (`'0x' + '1f'` reads as two harmless-looking pieces).
Keep a value on one line, where the rule can actually see it, rather than
relying on the rule to catch a value assembled at runtime.

The 15 test files under `src/**/__tests__/` are exempt by path and may hold
protocol fixtures that predate the rule; that exemption governs what's
fixed, not what's counted, and isn't a precedent for new code elsewhere.

If your change is caught by the guard and you believe it's a false positive,
say so in the PR rather than adding a new inline disable directive — the
existing three exemptions (all in `uint8ArrayToHex`) are pinned by a test,
and a fourth means editing that pin and explaining why.

## Confidentiality checklist before you open a PR

- [ ] No device values, byte sequences, command codes, register names, or
      private-tree paths in source, tests, docs, commit messages, or the PR
      description itself.
- [ ] If you touched `site/**`, you read the added prose specifically
      looking for reconstructable protocol detail — not just run the lint.
