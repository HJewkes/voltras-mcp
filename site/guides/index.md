---
diataxis: overview
audience: [lifter, coach]
status: available
sources:
  - src/tools/server-tools.ts
  - src/tools/plan-tools.ts
  - src/dashboard/README.md
lastVerified: 2026-09-28
---

# Guides

The guides assume the server is installed and you have run one session. If not, start with
[Get started](/start/), which ends with the [first-session tutorial](/start/first-session).
Each guide below is a set of steps toward one goal. For every tool a guide names, the
[capability reference](/reference/) has the full schema.

## The wall dashboard

- [The wall dashboard](/guides/dashboard): what the dashboard is, its five screens, and how
  it stays current.
- [Set it up and open it](/guides/dashboard-setup): build it, launch the server so it is on,
  find its address, and what to do when it does not open.
- [Live workout tour](/guides/dashboard-tour): published captures of each stage of the live
  page, from before a Voltra connects to the session summary and the two-device view.

## Training

- [Running a planned session](/guides/planned-session): build or import a plan, attach it
  to a live session, and run against its prescription.
- [Bilateral work](/guides/bilateral): connect and bind two Voltras, cascade settings across
  both with `bilateral.cascade`, and read per-slot events.
- [Isometric assessment](/guides/isometric): the single-hold primitive versus the two
  blocking protocols, trial validity, and the calibration caveat on the force figures.

## Planning

Plans live in the [`plan.*`](/reference/plan) tools: programs, blocks, weeks, workout
templates and the planned exercises in each template. The wall dashboard has a plan builder
page at `/app#/plan` for browsing the exercise catalog and editing a workout by hand. See
[the dashboard's screens](/guides/dashboard#the-five-screens) and the
[plan builder capture](/guides/dashboard-tour#building-the-plan-behind-it).

## Troubleshooting

- [Troubleshooting](/guides/troubleshooting): the common failures and their fixes, how to
  back up the training store, and how to rehearse a restore on a copy.

For what the numbers mean rather than how to get them, see [Understand your data](/concepts/).

Coaches, and lifters who share results with one, start at [For coaches](/coaches/). The
session report and weekly report guides moved there.
