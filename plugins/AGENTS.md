# Lint tooling

The registered rules and their configuration live in `.oxlintrc.json` at the
repository root. Keep rule severity at `error`, or `off` with a reason.
An exception at one site needs a scoped directive naming the rule and reason.
Do not downgrade the rule for every caller.

Every registered JS plugin must have a diagnostic-producing fixture in
`js-plugins-smoke.test.ts`. A plugin exception can leave oxlint exiting zero,
so lint success alone does not prove the plugin ran.

Keep oxlint pinned exactly. After changing a plugin, its registration, or the
oxlint version, run `bun test ./plugins` from the repository root. When
changing React Compiler rule settings, read their existing explanations in
`.oxlintrc.json` before changing the chosen exceptions.
