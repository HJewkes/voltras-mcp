# Security Policy

## Reporting a vulnerability

Please report security issues privately using [GitHub's private vulnerability
reporting](https://github.com/HJewkes/voltras-mcp/security/advisories/new)
(Security tab → "Report a vulnerability"). Do not open a public issue for a
security report.

There is no fixed response-time commitment. This is a one-person side
project, and a promise that can't be kept is worse than none — reports will
be triaged as soon as reasonably possible.

## This server drives physical hardware

`voltras-mcp` controls a Voltra resistance-training device over Bluetooth.
**A report describing unintended device actuation — the device moving,
loading, or changing resistance in a way the operator did not request — is a
safety issue, not only a software one**, and should be reported with that
urgency in mind. Treat it as security-relevant even if it doesn't fit a
conventional vulnerability shape.

## Scope

In scope:

- This repository's source (`src/`), the MCP tool/resource surface it
  exposes, and the local dashboard sidecar (`src/dashboard/`).
- Anything that could cause unintended or unsafe device actuation.
- Anything that could exfiltrate local data the server holds (the SQLite
  store, logs) to an unintended destination.

Out of scope:

- Vulnerabilities in upstream dependencies that already have an open
  advisory — report those upstream instead.
- The Voltra device's own firmware or BLE protocol implementation; this
  repository only consumes it.
