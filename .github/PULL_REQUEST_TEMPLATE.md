## What changed

<!-- One or two sentences, from a user's perspective. -->

## Changelog

- [ ] Added `changelog.d/<ticket>.md` for a user-visible change
- [ ] No user-visible change, so no fragment

## Gates run locally

- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run changelog:check`

## Docs pages (skip if no `site/` page changed)

- [ ] Every behavioural claim on each changed page was checked against source, one by one,
      not sampled (see `site/CONTRIBUTING-DOCS.md`)
- [ ] The ledger is below: per page, claims checked and every sentence changed
- [ ] Each fully checked page carries `sourced: <date>` in its front matter

## Hardware verification

- [ ] Verified against a real Voltra device
- [ ] Not verified against hardware (mock adapter / tests only) — expected,
      say why if it's not obvious
- [ ] Not applicable (no device-facing behavior changed)

## Confidentiality

- [ ] This PR introduces no device values, byte sequences, command codes,
      register names, or private-tree paths in code, comments, docs,
      commit messages, or this description.
