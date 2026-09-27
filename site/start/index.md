---
diataxis: overview
audience: [lifter, developer]
status: available
sources:
  - README.md
  - package.json
  - src/tool-registry.ts
lastVerified: 2026-09-27
---

# Get started

voltras-mcp is an MCP server that lets Claude drive a Voltra digital-resistance trainer. It
connects to the device, sets the load, and records every set and rep. It runs analytics over
your history and can coach you through a workout out loud. A local web dashboard shows the
set as it happens. The server speaks stdio only, so each Claude Code session runs its own
copy. ([README.md](https://github.com/HJewkes/voltras-mcp/blob/main/README.md))

## What you need

- **A Voltra, or the mock adapter.** `VOLTRA_ADAPTER=mock` replaces the device with an
  in-process one, so you can try everything without hardware.
- **Node 22.5.0 or later** (`engines` in `package.json`).
- **Claude Code**, as the MCP client.

## Read in this order

1. [Install](/start/install): requirements, clone, build, and register the server with
   Claude Code.
2. [Your first session](/start/first-session): a tutorial that opens a session, runs sets
   and closes out, with a Voltra or with the mock adapter.
3. [Try it without a device](/start/try-without-a-device): the mock adapter, the scripted
   dashboard drivers, and `npm run dashboard:preview`.
4. [Launch options](/start/launch-options): the `voltra-pt` launcher for push events,
   `.launch.env`, and running more than one instance.

After that, the [guides](/guides/) cover planned sessions, two devices, isometric tests and
the wall dashboard. The [capability reference](/reference/) lists every tool.
