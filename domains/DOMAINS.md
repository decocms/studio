# Domains

Index of declared domains. Each domain has a declaration at
`domains/<name>/DOMAIN.md` — the source of truth a reconciler agent enforces
via PRs. See `domains/DOMAIN.template.md` to add one, and run
`loop lint <name>` (from `@decocms/loop`) before the first `loop run <name>`.

A merged row is a live domain: `loop tick` (typically on cron) reconciles
every domain its runner's GitHub user owns. Activation is merging the
declaration; deactivation is removing the row.

| Domain | Paths | Owner |
| ------ | ----- | ----- |
| [i18n](./i18n/DOMAIN.md) | `apps/web/src/**` | @viktormarinho |
