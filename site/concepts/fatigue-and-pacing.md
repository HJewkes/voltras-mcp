---
title: Fatigue and pacing
description: How the server turns a set into a fatigue verdict, when the live card says stop, how tempo targets are chosen, and the two different things called a rest timer.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - src/tools/metrics-tools.ts
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/spa/live-page/fatigue-state.ts
  - src/state/velocity-loss-intent.ts
  - docs/push-events.md
  - site/reference/push-events.md
  - src/dashboard/tempo-defaults.ts
  - src/dashboard/spa/live-page/RestView.tsx
  - src/dashboard/spa/live-page/live-copy.ts
  - src/analytics/rest-defaults.ts
  - src/tools/timer-tools.ts
  - src/state/rest-timer.ts
  - src/state/channel-payloads.ts
  - src/tools/set-tools.ts
  - src/config.ts
  - package.json
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Fatigue and pacing

This page explains how the server reads fatigue inside a set, what the live card means when it
says stop, how a tempo target is picked, and how rest between sets is timed.

A few terms first.

- **Velocity loss** is how much slower your reps have become within one set, as a percentage.
  [Velocity and effort](/concepts/velocity-and-effort) explains it in full.
- **Range of motion (ROM)** is how far the cable travels in one rep.
- The **concentric** is the lifting part of a rep. The **eccentric** is the lowering part.
- **Tempo** is how long each part of a rep takes, in seconds.

## The fatigue verdict

The server sums up a set in one word: **good**, **slowing**, **grinding** or **form breakdown**.
You can ask for it with the `fatigue.verdict` pipeline of [`metrics.compute`](/reference/metrics).
It returns the same verdict the live fatigue card on the dashboard shows
(`src/tools/metrics-tools.ts:2505-2508`<!-- anchor: the same multi-dimension fatigue verdict -->, `src/dashboard/spa/panels/fatigue-view.ts:444-447`<!-- anchor: getSetFatigueVerdict -->).

The verdict looks at three things: velocity loss, ROM and tempo. Each one gets its own grade of
ok, warn or alarm, and the response lists all three (`src/tools/metrics-tools.ts:2506-2508`<!-- anchor: three per-dimension tones -->).
The calculation comes from
[`@voltras/workout-analytics`](https://www.npmjs.com/package/@voltras/workout-analytics), the
published analytics library this server depends on (`package.json:66`). Its function
`getSetFatigueVerdict` combines the three grades in a fixed order.

1. A ROM or tempo alarm gives **form breakdown**. This check runs first, so a fast-looking rep
   cannot hide it. A cheat rep keeps its speed up by cutting ROM and dropping the lowering
   phase, and this is the one signal that catches it (`src/tools/metrics-tools.ts:2508-2510`<!-- anchor: this is the one signal that catches it -->).
2. A velocity-loss alarm with clean form gives **grinding**.
3. Any warning gives **slowing**.
4. Otherwise the set is **good**.

What counts as an alarm, in that library's defaults:

- **ROM.** Each rep is compared with the set's own working range, not with a population figure.
  A rep cut below 75% of that range is an alarm, and one below 90% is a warning. A rep longer than
  usual raises nothing. The live card draws the same 75% line on its ROM chart
  (`src/dashboard/spa/panels/fatigue-view.ts:454-455`<!-- anchor: workingStandard * 0.75 -->).
- **Tempo.** A lowering phase that speeds up sharply is a loss of control and can reach an alarm.
  A slow, effortful lift is a sign of tiredness, not bad form, so it can only reach a warning.
- **Velocity loss.** The verdict grades loss on fixed bands: a warning from 20% and an alarm from
  30%. That is separate from your set's own stop threshold, described in the next section.

With fewer than two reps there is nothing to compare against, so the verdict is empty. The card
shows "warming up" instead of a guess (`src/tools/metrics-tools.ts:2511`<!-- anchor: `null` below 2 reps -->,
`src/dashboard/spa/panels/fatigue-view.ts:444-447`<!-- anchor: warming up -->).

## When the live card says stop

The live card colours your set in three states: keep going, approaching the stop, and stop. The
card reads **stop** when velocity loss reaches your set's stop threshold, or when the verdict is
form breakdown. It reads **approaching** from two thirds of the stop threshold, or when the ROM or
tempo grade is not ok (`src/dashboard/spa/live-page/fatigue-state.ts:30-38`<!-- anchor: stop.bands[1] -->,
`src/state/velocity-loss-intent.ts:145-155`<!-- anchor: export function stopThirdsBands -->).

The stop threshold is chosen in this order (`src/state/velocity-loss-intent.ts`):

- the threshold the set's own watch set at the start, which is the number the server's
  `velocity_loss_exceeded` event fires at;
- else the training goal on the planned exercise;
- else the hypertrophy default, 30% (`src/state/velocity-loss-intent.ts:45-49`<!-- anchor: hypertrophy: 30 -->,
  `src/state/velocity-loss-intent.ts:113`<!-- anchor: DEFAULT_STOP_INTENT -->).

So the wall turns red at the same moment the server's own event fires
(`src/dashboard/spa/live-page/fatigue-state.ts:4-6`<!-- anchor: the server's own threshold for the set -->).
[Velocity and effort](/concepts/velocity-and-effort#why-slowing-down-tracks-effort) explains why
the default differs by goal.

## The two stop events are advice

Claude learns about a set through push events: short messages the server sends without being
asked ([push events](/reference/push-events)). Two of them matter for stopping.

- `set_target_reached` fires when the set reaches a rep count Claude asked to be told about.
- `velocity_loss_exceeded` fires when velocity loss passes the set's threshold.

Neither one ends the set. They are advisory cues: the event goes out, and the set keeps running
until you finish or ask Claude to end it (`site/reference/push-events.md:22-23`<!-- anchor: No — advisory cue only -->,
`docs/push-events.md:405-409`<!-- anchor: advisory cues only -->). A set can still close without you, for example on the device's
own end-of-set signal or after the inactivity timeout, for when you have walked away
(`docs/push-events.md:409-413`<!-- anchor: the one remaining -->, `src/state/rest-timer.ts:3-4`<!-- anchor: the inactivity watchdog -->).

A few details shape when `velocity_loss_exceeded` fires.

- It measures loss on each rep's peak lifting speed, against the fastest eligible rep in the set.
  A rep far off the set's typical range or speed is not eligible, so a positioning pull or a
  half rep cannot set the baseline (`docs/push-events.md:541-545`<!-- anchor: ELIGIBLE reps -->).
- With the lowering phase loaded heavier than the lift, the first two reps are left out. They
  are fast for mechanical reasons, not because you are fresh (`docs/push-events.md:552-557`<!-- anchor: first two reps -->).
- On a pulling movement it does not fire at all. Peak speed on a fast pull does not drop with
  fatigue, so the server says at the start that the watch is off
  (`docs/push-events.md:594-598`<!-- anchor: trigger does not fire -->).
- The server warns that velocity loss is a volume dial and a poor measure of how close you are
  to failure. Reps completed to a fixed threshold vary by about five either way between sessions
  (`docs/push-events.md:464-467`<!-- anchor: volume-dial caveat -->).

## Pacing each rep

A tempo target is four numbers in seconds: lowering, pause at the bottom, lifting, pause at the
top (`src/dashboard/tempo-defaults.ts:21-22`<!-- anchor: export type TempoTuple -->). The dashboard picks the target in this order
(`src/dashboard/tempo-defaults.ts:72-77`<!-- anchor: in priority order -->):

1. the tempo your coach set on the planned exercise;
2. the exercise's default;
3. none, and the tempo readout is hidden.

Defaults come from the movement pattern. A press defaults to 3-0-1-0, for example: three seconds
down, no pause, one second up, no pause (`src/dashboard/tempo-defaults.ts:32-40`<!-- anchor: push: [3, 0, 1, 0] -->). A few
exercises override their pattern, and a loaded carry has no rep tempo at all
(`src/dashboard/tempo-defaults.ts:29-30`<!-- anchor: `carry` is intentionally absent -->, `src/dashboard/tempo-defaults.ts:48-52`<!-- anchor: export const byExercise -->).

The live card tints each rep by how far its lifting time sat from the target lifting time
(`src/dashboard/spa/panels/fatigue-view.ts:145-154`<!-- anchor: function tempoDeviationFor -->,
`src/dashboard/spa/panels/fatigue-view.ts:432-434`<!-- anchor: per-rep tempo-deviation tint -->). That tint is about pace. The tempo grade in
the fatigue verdict is a different check: it compares your reps with each other, not with a
target.

## Rest between sets

Two different mechanisms both get called a rest timer. They do different jobs, and one does not
drive the other.

### The rest clock on the dashboard

After a set closes, the dashboard counts down a rest length. It uses the rest from your plan when
there is one. Otherwise it uses a default for the exercise's training goal and labels it "Default
rest", so it never reads as your coach's number (`src/dashboard/spa/live-page/RestView.tsx:55-57`<!-- anchor: captioned as a default -->,
`src/coach-copy/dashboard.ts`). With no rest target at all, it counts up from
the end of the set instead (`src/dashboard/spa/live-page/RestView.tsx:244-252`<!-- anchor: mode="up" -->).

The goal defaults are 150 seconds for strength, 105 seconds for hypertrophy, and 120 seconds for
any other goal or when no goal is known (`src/analytics/rest-defaults.ts`). A default rest can grow. If your last
set reached its stop threshold in fewer reps than the set before it, the next rest gets 30 extra
seconds per rep lost, up to 60 seconds. A rest your coach set is never extended
(`src/analytics/rest-defaults.ts:124-131`<!-- anchor: A coach-set rest is never extended -->). The research
behind this links a falling rep count to rest that was too short
(`src/analytics/rest-defaults.ts`).

[`timer.start`](/reference/timer) uses the same rule when Claude starts a rest timer without a
length, and its result says where the length came from (`src/tools/timer-tools.ts`).

### The server's rest status messages

Separately, the server can send Claude a `rest_status` push event while you rest. This is off by
default and turned on with `VMCP_REST_TIMER=on` (`src/config.ts:298-300`<!-- anchor: VMCP_REST_TIMER ?? 'off' -->,
`src/tools/set-tools.ts:1192-1201`<!-- anchor: config.restTimer === 'on' -->). It sends one message when the set closes, then one every 15
seconds, and stops at five minutes with a final message (`src/state/rest-timer.ts:9-12`<!-- anchor: `final: true` -->,
`src/state/rest-timer.ts:45`<!-- anchor: REST_STATUS_INTERVAL_MS = 15_000 -->, `src/state/rest-timer.ts:55`<!-- anchor: REST_STATUS_CAP_MS = 300_000 -->). Starting the next set cancels it
(`src/state/rest-timer.ts:19-21`<!-- anchor: next set began -->).

These messages carry only the time elapsed. They hold no rest target
(`src/state/channel-payloads.ts:2251-2280`<!-- anchor: export function buildRestStatusPayload -->). They let Claude keep track of your rest without
waiting or polling. They do not draw the clock on the wall.
