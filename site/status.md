---
diataxis: reference
audience: [lifter, coach, developer]
status: available
sources:
  - scripts/lib/docs-checks.mjs
  - site/.vitepress/theme/status.ts
lastVerified: 2026-09-27
---

# Page status

Every page on this site declares one of three statuses. The status describes the thing the
page documents, not the page itself. A page with no badge is **Available**.

## Available

**What it means.** The feature works end to end on `main`, and the page's claims point at the
source files that back them. Those files are listed in the Sources footer at the bottom of
the page.

**What you can rely on.** You can use the feature today, as the page describes it. If the
behaviour changes, the page changes in the same pull request.

## Experimental

**What it means.** The feature works on `main`, but it is off by default, not yet validated
against a real device, or not yet calibrated. The page names which of these applies, in a
note under the title.

**What you can rely on.** You can try it. Its behaviour, its inputs and its outputs may change
without notice, and its numbers may not be accurate yet. Do not build a routine or a coaching
decision on it.

## Coming soon: not yet usable

**What it means.** Part of the feature exists in the code, or it has a design, but it is not
wired end to end. You cannot use it today. The note under the title says what does not work
and links the issue that tracks it.

**What you can rely on.** Nothing yet. The page describes intent, not behaviour. The
[roadmap](/roadmap) lists the same kind of item in one place.

## How the status shows

- A badged page shows its status as a word above the title, with a note that says what does
  not work. The word links back to this page.
- Search results put the status word in front of a badged page's title.
- The Sources footer lists the files the page's claims come from, and the date someone last
  checked the page against them.
- `npm run docs:check` fails when a page has no status, when an Experimental or Coming soon
  page has no note, when a Coming soon page has no tracking issue, or when a listed source
  file does not exist.
