# Changelog fragments

One file per pull request with a user-visible change, named after its ticket
(`VW-123.md`). The front matter names the group and the body is the entry:

```markdown
---
section: Fixed
---

- The rest timer no longer skips its last ten seconds (VW-123, #456).
```

`section` is one of Added, Changed, Deprecated, Removed, Fixed or Security.
`npm run changelog:check` validates every file here. At release,
`npm run changelog:fold -- --version <x.y.z>` folds them into `CHANGELOG.md`
and deletes them. How to write the entry itself is in the "How to write an
entry" section of `CHANGELOG.md`.
