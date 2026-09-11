---
name: Bug report
about: Something isn't working as expected
labels: bug
---

**⚠️ If this is about the device doing something unintended or unsafe
(unexpected movement, resistance, or loading), please use [private
vulnerability reporting](../../security/advisories/new) instead of a public
issue.**

## What happened

<!-- What did you do, what did you expect, what happened instead? -->

## `server.health` output

Run the `server.health` tool and paste its output here — it reports
version, build, adapter (real/mock), SDK version, and analytics-package
version in one call, which is the fastest way for us to know what you're
running.

**Before pasting: `dbPath` and `dashboardUrl` in the output are local
filesystem paths / URLs on your machine. Redact them (or anything else you'd
rather not share) before posting.**

```
<!-- paste server.health output here -->
```

## Adapter mode

- [ ] `VOLTRA_ADAPTER=mock` (no hardware)
- [ ] `VOLTRA_ADAPTER=node` (real device over BLE)

## Steps to reproduce

1.
2.
3.

## Environment

- OS:
- Node version:
- `voltras-mcp` version (from `server.health`):
