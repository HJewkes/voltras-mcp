# Contributing to the docs site

## The citation rule

This site is public. Every claim on a page must cite a file, tool name, or merged PR that
exists on `main` — a relative link to the file/doc in question, or a link to the tool by
its registered name, is enough. If you can't point at where a claim comes from, cut the
claim instead of writing it from memory.

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
