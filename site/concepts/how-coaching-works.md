---
title: How coaching works
description: Who decides what gets said during a workout, how the server's automatic cues work, how your experience tier shapes advice, where coaching.explain gets its answers, and the limits of the spoken stop.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - plugins/voltras-channel/skills/pt-session/SKILL.md
  - src/config.ts
  - src/voice/cue-policy.ts
  - src/voice/cue-emitter.ts
  - src/voice/cue-settings.ts
  - src/tools/tier-signal.ts
  - src/tools/profile-tools.ts
  - src/tools/coaching-tools.ts
  - src/tools/coaching-content.ts
  - src/tools/voice-tools.ts
  - src/tools/tts-tools.ts
  - src/voice/transcript-router.ts
  - src/voice/voice-listener.ts
lastVerified: 2026-09-27
---

# How coaching works

This page explains how coaching decisions get made during a session. It covers who speaks, what
the server says on its own, how your experience level shapes advice, and what the spoken stop can
and cannot do.

## Claude is the coach, the server is the instrument

The server measures and records. Claude, reading what the server reports, does the coaching.

The **pt-session skill** is the set of instructions that tells Claude how to act as your trainer.
It covers two kinds of work: a live workout with the device, and a sitting with no device, such
as a weekly review or planning the next block
(`plugins/voltras-channel/skills/pt-session/SKILL.md:9-12`). It ships inside this repo, so it is
never older than the server it came with (`plugins/voltras-channel/skills/pt-session/SKILL.md:14`).

The skill sets rules Claude follows. Two examples: never promise that a set will stop on its own,
and never strip the experience tier from coaching advice
(`plugins/voltras-channel/skills/pt-session/SKILL.md:188`,
`plugins/voltras-channel/skills/pt-session/SKILL.md:198`).

## Automatic spoken cues

A **cue** is a short spoken line, such as a set intro or a note that you are slowing down. Cues
can come from two places.

- **Claude speaks** through [`system.speak`](/reference/system). This is the default. With
  automatic cues off, Claude drives all speech (`src/config.ts:106-113`).
- **The server speaks on its own**, the instant an event fires. This avoids the delay of waiting
  for Claude, which once made a rep count arrive after the set had ended
  (`src/voice/cue-emitter.ts:1-5`). It works on macOS only, through the built-in `say` voice
  (`src/config.ts:114-116`).

When the server speaks on its own, a fixed rule called `decideCue` picks the line. It maps four
events to four kinds of cue and ignores every other event (`src/voice/cue-policy.ts:29-46`):

| Event                    | Cue          | When it can play |
| ------------------------ | ------------ | ---------------- |
| `set_started`            | set intro    | between sets     |
| `set_ended`              | set complete | between sets     |
| `set_target_reached`     | target hit   | mid-set          |
| `velocity_loss_exceeded` | slowdown     | mid-set          |

The rule has no memory: the same event always gives the same decision
(`src/voice/cue-policy.ts:5-7`). A slowdown cue is urgent and interrupts whatever is being said
(`src/voice/cue-policy.ts:108-115`). Each kind of cue plays at most once per set
(`src/voice/cue-emitter.ts:54-57`).

Two switches control this, and both are off by default:

- `VMCP_CUES` turns automatic cues on at all (`src/config.ts:13`, `src/config.ts:106-117`).
- `VMCP_CUES_MIDSET` also allows the two mid-set cues. They are off by default because every cue
  mutes the microphone while it plays, which matters for the spoken stop described below
  (`src/config.ts:14`, `src/config.ts:120-135`).

[`system.set_cues`](/reference/system) changes either switch while the server runs, with no
restart (`src/voice/cue-settings.ts:1-12`).

## The effort cue

There is a third, separate switch: `VOLTRAS_EFFORT_CUE`, off by default (`src/config.ts:16`,
`src/config.ts:299`). When on, an effort rule decides the one ending cue for a set. It picks at
most one of: target reps reached, velocity loss exceeded, or an effort target reached, and it stores
a record of the cue with the set. It stays off by default until it has been tested on the device
(`src/config.ts:151-158`). [Velocity and effort](/concepts/velocity-and-effort#when-the-server-will-state-a-number)
explains the strict conditions it puts on your effort curve.

## Your experience tier

Advice depends on how experienced you are. The server's **tier signal** places you as a
**beginner**, **intermediate** or **advanced** lifter (`src/tools/tier-signal.ts:28`), and
[`profile.get_tier_signal`](/reference/profile) reports it (`src/tools/profile-tools.ts:265-271`).

It answers two questions separately (`src/tools/tier-signal.ts:4-14`):

- **How sure is it?** The tier counts as confident only after 24 training days logged over 12
  weeks.
- **How high can it go?** The tier can rise to intermediate when you report having hit a plateau, plus either that logged
  history, or a record of earlier training with only a short break since. The server never
  derives advanced, and it only ever lowers the tier you declared, never raises it.

Several tools read the tier (`src/tools/tier-signal.ts:16-19`):

- [`plan.warmup_ramp`](/reference/plan) uses it for the number of warm-up steps.
- [`report.weekly`](/reference/report) and [`plan.suggest_progression`](/reference/plan) use it
  to decide whether a set may be added.
- The plan checks use it for volume ceilings.
- [`profile.get_starting_prescription`](/reference/profile) uses it for your first loads.

Goal setting reads the tier you declared instead, and flags when the server's own reading
disagrees (`src/tools/tier-signal.ts:18-19`).

## Where coaching.explain gets its answers

[`coaching.explain`](/reference/coaching) answers coaching questions by topic. Topics are grouped
by the kind of conversation: onboarding, live coaching, the training block, and diet
(`src/tools/coaching-tools.ts:30-36`).

Its knowledge is **RP-derived**: it comes from a curated set of mined coaching notes, and each
note's id starts with `rp-` (`src/tools/coaching-content.ts:13-16`,
`src/tools/coaching-content.ts:50-52`). Five topics draw on published research instead, and cite
author and year (`src/tools/coaching-tools.ts:43-48`).

Every answer states its numbers per tier, in the prose itself. A number from this material without
its tier is meaningless, so Claude is told never to strip the tier when passing it on
(`src/tools/coaching-tools.ts:37-40`). If the tier is not known yet, the answer gives every tier
at once (`src/tools/coaching-tools.ts:39-40`).

Every answer also lists its sources. When the source material disagrees with itself, the answer
carries a caveat, and Claude quotes a range rather than one number
(`src/tools/coaching-tools.ts:40-42`).

## The spoken stop, and its blind spot

You can stop the weight by voice. [`system.listen_start`](/reference/system) turns on a
microphone that runs on your machine, and it is off until something calls it
(`src/tools/voice-tools.ts:1-14`). Once it is on, short phrases such as "stop", "unload" or "cut
the weight" unload every connected device, with no wait for Claude
(`src/voice/transcript-router.ts:22-31`, `src/tools/voice-tools.ts:7-11`). A phrase like "don't
stop" is ignored, and so is a long sentence that merely contains the word
(`src/voice/transcript-router.ts:33-49`).

::: warning The microphone is deaf while anything is spoken
Today, while any line plays, whether Claude's speech or an automatic cue, the microphone is
muted and the sound it hears is thrown away. A spoken "stop" in that window is lost, with no event
to say so (`src/voice/voice-listener.ts:17-19`, `src/voice/voice-listener.ts:505-512`,
`plugins/voltras-channel/skills/pt-session/SKILL.md:176`). A single mute lasts at most eight
seconds (`src/tools/tts-tools.ts:120-129`). The fix is tracked as VW-173 and is not on `main`
yet.
:::

That is why the mid-set cues are off by default (`src/config.ts:120-128`). It is also why the
skill tells Claude to keep lines short and stay silent during a heavy set, and to have you keep a
hand near the device's own stop (`plugins/voltras-channel/skills/pt-session/SKILL.md:176`).
