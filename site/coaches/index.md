---
title: For coaches
description: What a coach gets from a lifter who trains with voltras-mcp, and where to read about each part.
diataxis: overview
audience: [coach]
status: available
sources:
  - README.md
  - src/tools/report-tools.ts
  - src/tools/truecoach-tools.ts
lastVerified: 2026-09-27
---

# For coaches

These pages are for a coach whose client trains on a Voltra with Claude as the in-session
trainer. You never install anything and you never touch the device. What you get:

1. A plain-text result for each session, in the same `170 lb x 12` style a TrueCoach
   result box uses ([`report.session_results`](/reference/report), `README.md`).
2. A weekly rollup: training days, adherence to the plan, flagged sets, and progression
   suggestions labelled "not applied" ([`report.weekly`](/reference/report),
   `src/tools/report-tools.ts`).
3. Your TrueCoach programming, pulled into the lifter's local plan by a read-only import
   ([`truecoach.import_week`](/reference/truecoach), `src/tools/truecoach-tools.ts`).
4. No automatic feed. The server keeps its records on the lifter's machine, and a report
   reaches you only when the lifter sends it or turns on the tool in item 5
   ([Consent and the data loop](/coaches/consent-and-data-loop)).
5. An optional, gated tool that posts results into TrueCoach for the lifter. It carries
   account risk for you, so the lifter must tell you before using it (`README.md`).

## Pages

- [The onboarding model](/coaches/onboarding-model): who does what, and how a session
  becomes a report and a report becomes next week's plan.
- [Consent and the data loop](/coaches/consent-and-data-loop): what is shared, when, and
  how to stop it, with TrueCoach's terms quoted in full.
- [Onboard a client](/coaches/onboard-a-client): paired steps for you and the lifter, from
  install to the first report.
- [Read a session report](/coaches/read-a-session-report) and
  [Read the weekly report](/coaches/read-the-weekly-report).
- [Import a TrueCoach week](/coaches/import-a-truecoach-week).
- [Glossary](/coaches/glossary): the training and tool terms these pages use.
