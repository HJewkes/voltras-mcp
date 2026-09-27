---
title: Privacy and local data
description: Where your training record lives, who can reach the dashboard, what leaves your machine and when, how to back the record up, and the promise about device protocol detail.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - src/config.ts
  - src/store/sqlite-store.ts
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/logger.ts
  - src/tools/voice-tools.ts
  - src/tools/tts-tools.ts
  - src/integrations/truecoach/client.ts
  - src/docs/protocol-guard.ts
  - site/coaches/consent-and-data-loop.md
  - README.md
  - CLAUDE.md
lastVerified: 2026-09-27
---

# Privacy and local data

This page explains where your training data lives, who can reach it, and what leaves your
machine. The short answer: it all stays on your machine unless you turn something on.

## Your record is one file on your machine

Every session, set and rep goes into one database file: `~/.voltras/vmcp.sqlite` unless you set
`VMCP_DB_PATH` to move it (`src/config.ts:5`). The database is SQLite, run by Node's own built-in
module, so there is no database server and no account (`src/store/sqlite-store.ts:22`).

The same folder can hold a few other files. The device slot assignments sit there
(`src/config.ts:6`). A TrueCoach login token, cache and outbox appear there only if you use those
features (`src/config.ts:17-19`, `src/config.ts:242-243`).

Keep one server process per database file. Two processes on the same file can both open it, and
their writes then fail ([README](https://github.com/HJewkes/voltras-mcp#running-more-than-one-instance)).

## The dashboard only answers your own machine

The server runs a small web dashboard next to itself. It listens on `127.0.0.1`, the address that
only your own computer can reach, so a phone or another computer on your network cannot open it
(`src/dashboard/server.ts:4-11`, `src/dashboard/server.ts:241-242`). It sends no headers that
would let another website read its data (`src/dashboard/server.ts:14-17`).

Most of its routes only read: the live view, your history, your plan, and your goals
(`src/dashboard/server.ts:28-85`). A small set of routes can change things: six routes that edit
your training plan, and an action route that runs only tools on a fixed list
(`src/dashboard/server.ts:87-102`, `src/dashboard/server.ts:1178-1186`).

Every change request passes a guard before anything else happens
(`src/dashboard/server.ts:558-575`). The guard requires all of these
(`src/dashboard/write-guard.ts:12-32`):

- the request is addressed to your own machine by name;
- it comes from the dashboard's own page, not another website;
- it is sent as JSON, which a plain web form cannot do;
- it carries a secret made fresh each time the server starts.

The guard protects you from other web pages. It does not protect you from another program
running under your own account, which could read the database file directly anyway
(`src/dashboard/write-guard.ts:34-36`).

## What leaves your machine

By default, the server sends nothing to anyone
([Consent and the data loop](/coaches/consent-and-data-loop#local-by-default)).

- **Logs** go to your terminal's error stream only (`src/logger.ts:1-4`).
- **Voice.** Listening runs on your machine: speech detection and transcription run inside the
  server process (`src/tools/voice-tools.ts:1-5`). Speaking uses the voice built into macOS
  (`src/tools/tts-tools.ts:1-8`).
- **Claude.** Tool results do go into your conversation with Claude, because that is how Claude
  reads them. That conversation belongs to your own Claude Code session, which this server does
  not control ([Consent and the data loop](/coaches/consent-and-data-loop#local-by-default)).

Two TrueCoach features can send or fetch data, and both are opt-in:

- **The TrueCoach import** reads your own assigned workouts, and only when a tool call asks it
  to. Apart from logging in, it only reads, and nothing runs on a timer
  (`src/integrations/truecoach/client.ts:3-8`).
- **The TrueCoach write-back** is a separate tool that posts results into TrueCoach. It is off by
  default and not installed with the server (`src/config.ts:19`,
  [Consent and the data loop](/coaches/consent-and-data-loop#truecoach-write-back-experimental-and-gated)).

[Consent and the data loop](/coaches/consent-and-data-loop) covers both features, TrueCoach's
terms of service, and how to switch each one off.

## Backing up

`npm run store` exports the whole database to plain text files, rebuilds a database from them,
and checks that the two match. It is your backup and your way out
([README](https://github.com/HJewkes/voltras-mcp#backing-up-the-training-store)). Stop every
server process before you copy the live file, so the copy is not taken mid-write
([README](https://github.com/HJewkes/voltras-mcp#rehearsing-on-a-copy)).

An export holds your whole training record in plain text. Keep it somewhere as private as the
database itself, and delete a practice copy when you are done
([README](https://github.com/HJewkes/voltras-mcp#rehearsing-on-a-copy)).

## The promise about device internals

The device maker shared details of how the Voltra communicates to help the community SDK, and
asked that they stay private (`CLAUDE.md`, "Confidentiality / Privacy"). This project keeps that
request.

No raw device messages, byte values or device command codes appear in any tool's input or
output, in any log line, in any documentation page, or in any commit. Only plain values such as
weights, speeds and counts cross from the device into what Claude sees
([README](https://github.com/HJewkes/voltras-mcp#confidentiality)). A lint rule checks the source
code, and a separate guard checks the generated documentation pages for anything shaped like
device detail (`CLAUDE.md`, "Confidentiality / Privacy"; `src/docs/protocol-guard.ts:1-5`).
