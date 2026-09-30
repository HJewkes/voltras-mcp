---
diataxis: how-to
audience: [developer]
status: available
sources:
  - package.json
  - scripts/check-docs.mjs
  - scripts/lib/docs-checks.mjs
  - site/.vitepress/theme/DocSources.vue
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Contributing to the docs site

## The citation rule

This site is public. Every claim on a page must cite a file, tool name, or merged PR that
exists on `main` — a relative link to the file/doc in question, or a link to the tool by
its registered name, is enough. If you can't point at where a claim comes from, cut the
claim instead of writing it from memory.

## Review a page claim by claim

A reviewer who spot-checks three claims and passes the page has validated those three
claims and nothing else. On one docs pull request, a spot-check passed a page that a full
pass later found three different wrong sentences on. So a docs review is a per-claim
sourcing pass, never a sample:

1. List every behavioural claim on the page: anything it says the product, a tool, the
   dashboard or a setting does.
2. Check each one against the source file that implements it, not against the README or
   another page. Note the file and line.
3. Fix a wrong claim. Soften or remove a claim you cannot find in the source; never keep one
   on faith.
4. Put the ledger in the pull request body: per page, the number of claims checked and every
   sentence you changed.
5. Set `sourced: <date>` in the page's front matter, next to `lastVerified`. The footer then
   tells the next reader the page had a full pass, and `npm run docs:check` rejects a date
   that is not real.

A page without `sourced` has only been spot-checked. Leave the field off a page you did not
check claim by claim, and update it only after a new full pass.

## The confidentiality rule

No protocol bytes, parameter ids, command codes, decoded byte layouts, or register names
may appear on any page, in any screenshot, or in any commit that touches this site. Describe
behaviour in prose and unit words only. If a source doc you're drawing from carries protocol
detail, don't port that passage — flag it instead of writing around it.

## Running the site locally

From the repo root:

```bash
npm run docs:dev    # dev server with live reload
npm run docs:build  # production build, output gitignored
```
