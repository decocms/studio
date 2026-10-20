# Shared contracts and utilities

Keep shared code isomorphic and expose it through explicit package subpaths.
Async utility signatures and options live in `src/std`; preserve cancellation
and portability when extending them.

## Organization flags

Boolean org settings belong in the `organization_settings.flags` JSON bag.
Define them in `OrgFlagsSchema` in `src/organization/schema.ts`, then run
`bun run --cwd=apps/api generate:tool-contracts` from the repository root.
Non-booleans and values needing indexes or constraints get their own columns.

Read flags with `orgFlagEnabled(flags, flag)` on the API or `useOrgFlag(flag)`
on the web. `DEFAULT_ON_FLAGS` owns which flags default on; raw property reads
do not implement those defaults.

Update through `ORGANIZATION_SETTINGS_UPDATE`. Updates shallow-merge the bag:
omitted keys survive and explicit `false` persists. Preserve this behavior
when changing the schema or update path.
