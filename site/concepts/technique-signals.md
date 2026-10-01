---
title: Technique signals
description: What the server can say about how you move, from range of motion to pauses, bounces, tempo and left-right imbalance, and what a cable sensor cannot see.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - src/state/event-bridge.ts
  - src/tools/metrics-tools.ts
  - src/analytics/rom-integrity.ts
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/spa/live-page/fatigue-model.ts
  - src/tools/isometric-tools.ts
  - docs/push-events.md
  - package.json
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Technique signals

This page explains what the server can tell you about how you move, and where that stops. It
covers range of motion, pauses and bounces inside a rep, tempo, and differences between your
left and right side.

## What the server can see

Everything on this page comes from the cable. While you move, the device streams readings of the
cable's position, speed and force, and the server groups them into reps
(`src/state/event-bridge.ts:24-27`). **Range of motion (ROM)** is how far the cable travels in
one rep, worked out from those positions ([Calibration and trust](/concepts/calibration-and-trust#measured-and-derived)).

The technique readings are pipelines of [`metrics.compute`](/reference/metrics). They share one
habit: when no cited cut-off exists, they report the raw measurement and leave the verdict empty
rather than invent one (`src/tools/metrics-tools.ts:2547-2557`, `src/analytics/rom-integrity.ts:22-25`).
The cut-offs they do use come from
[`@voltras/workout-analytics`](https://www.npmjs.com/package/@voltras/workout-analytics), the
published analytics library this server depends on (`package.json:66`,
`src/analytics/rom-integrity.ts:14-17`).

## Range of motion

`quality.rom` checks whether your reps kept their range within one set. It compares the set with
itself and needs no history (`src/tools/metrics-tools.ts:2558-2560`).

- Each rep is shown as a share of the set's typical rep, the median of its eligible reps. A rep
  that looks like a positioning pull is marked not eligible rather than dropped.
- The last eligible rep is compared with the first. Below 80% reads as **shrinking**.
- The spread of ROM across the set is graded **stable**, **variable** or **erratic**, with cuts
  at 10% and 20% variation (`src/tools/metrics-tools.ts:2560-2564`).

No population ROM figure is used anywhere. Body size, cable setup and seat position all change
ROM without anything changing about your technique, so there is no correct ROM for everyone
(`src/tools/metrics-tools.ts:2565-2566`, `src/analytics/rom-integrity.ts:4-9`).

A comparison with an earlier session is harder. `quality.rom` gives one only when three things
hold: the exercise's baseline is at least provisional, the drift check calls the two sessions
comparable, and both use the same position scale. A seat or attachment change reads exactly like
a ROM change, which is why the drift check has a say. When any of the three fails, the response
says which one (`src/tools/metrics-tools.ts:2566-2572`). `quality.rom` is a readout only. It
drives no spoken cue and no push event (`src/tools/metrics-tools.ts:2573`).

## Pauses and bounces

`quality.hesitation` looks for dips in speed during the lift, between 15% and 85% of the way
through the range. For each dip it reports where it happened and how deep it was. It never calls
a dip a real hesitation, because that needs a depth cut-off nobody has published, so the verdict
stays empty (`src/tools/metrics-tools.ts:2545-2550`).

`quality.bounce` measures how long you stayed at each turnaround, at the bottom and at the top.
It also compares the lowering phase's peak speed with the lift's. It does not call a rep a bounce
or a dropped rep, for the same reason: there is no citable threshold for either
(`src/tools/metrics-tools.ts:2551-2557`).

Both are read after the set, never live. Neither one drives a cue
(`src/tools/metrics-tools.ts:2549-2550`, `src/tools/metrics-tools.ts:2556-2557`).

`quality.rep` is the one technique reading that needs a baseline. You pick a real earlier set,
and it scores each rep against it (`src/tools/metrics-tools.ts:2510-2511`).

## Tempo and the live card's lights

**Tempo** is how long each part of a rep takes: lowering, pause at the bottom, lifting, pause at
the top. The live card shows your set's tempo next to the target tempo when there is one
(`src/dashboard/spa/panels/fatigue-view.ts:447-448`).

The card also carries three lights under its fatigue verdict: velocity loss, form (ROM) and
tempo (`src/dashboard/spa/live-page/fatigue-model.ts:105-107`,
`src/tools/metrics-tools.ts:2472-2474`). A ROM or tempo alarm turns the verdict to form breakdown,
even when your speed looks fine. [Fatigue and pacing](/concepts/fatigue-and-pacing#the-fatigue-verdict)
explains the lights and how they combine.

## Left and right

With two Voltras, one per side, the server tracks each device as a **slot**: `left` or `right`.
Most push events name their slot, so the two rep streams stay apart
(`docs/push-events.md:44-50`).

The live card stays one card. Its verdict and lights describe you as a whole. The only per-side
figure on it is the imbalance: the gap in mean rep speed between the two sides, as a share of the
faster side (`src/dashboard/spa/panels/fatigue-view.ts:362-382`). If the two units were set up differently,
the card withholds that figure and shows the reason instead. A different anchor makes the same
load a different effort, so the gap would describe the rig, not you
(`src/dashboard/spa/panels/fatigue-view.ts:331-338`, `src/dashboard/spa/panels/fatigue-view.ts:348-358`).

[`isometric.measure_imbalance`](/reference/isometric) is the formal test. It tests each side in
turn with a rest between them, 120 seconds by default. When your dominant side is known, it tests
the other side first so fatigue does not favour it (`src/tools/isometric-tools.ts:255-259`). It
has no fixed threshold for a meaningful imbalance. A difference counts as real only when it is
bigger than your own trial-to-trial spread on the same test (`src/tools/isometric-tools.ts:273-286`).
The direction over repeated tests matters more than one reading
(`src/tools/isometric-tools.ts:288-294`). The [bilateral guide](/guides/bilateral) covers the
setup.

## What these signals cannot show

The server reads a cable, not a body. It has no camera and no video. It cannot see your bar path,
your posture or your joint angles. The isometric tools say this directly: they take the joint
angle of your setup as an input, because they cannot measure it
(`src/tools/isometric-tools.ts:146-151`).

So a signal on this page tells you that something changed, not why. A shorter rep might be
fatigue, a changed grip, or a moved seat (`src/tools/metrics-tools.ts:2570`). When a reading
surprises you, compare it with a set you trust, and check the setup before the technique.
