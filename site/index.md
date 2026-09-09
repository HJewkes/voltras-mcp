---
layout: home
hero:
  name: voltras-mcp
  text: MCP server for the Voltra trainer
  tagline: Connect, load, record, and analyze a workout — driven from Claude.
---

# What this is

voltras-mcp is an MCP (Model Context Protocol) server that turns a Voltra digital-resistance
trainer into something Claude can drive: connect to the device, set the load, record sets
and reps, run analytics over the history, and coach you through a workout out loud. It also
ships a local web dashboard so you can watch the set happen on a screen instead of in a chat
log. ([README.md](https://github.com/HJewkes/voltras-mcp/blob/main/README.md))

It speaks stdio only — one server process per Claude Code session.
([README.md](https://github.com/HJewkes/voltras-mcp/blob/main/README.md))

## Where to start

- **[Install and run](/install-and-run)** — clone, build, and register the server with
  Claude Code.
- **[Capability reference](/reference/)** — the tools, resources and push events the
  server exposes, generated from the registry itself.
- **[The repository](https://github.com/HJewkes/voltras-mcp)** — source, issues, and the
  full [README](https://github.com/HJewkes/voltras-mcp/blob/main/README.md).
