# Vendored: Blocks content protocol

A copy of `packages/blocks/src/protocol` from [decocms/blocks](https://github.com/decocms/blocks)
at commit `ccdf6c259a1bf8a0341ea453659ca4bfc9c7db83`, which is `@decocms/blocks/protocol` in the
unpublished `@decocms/blocks@8`.

**Never edit these files by hand.** Fix the protocol upstream, then resync:

```sh
bun run scripts/sync-blocks-protocol.ts <path-to-blocks-checkout> <commit>
```

The sync copies the tree at that commit, leaves out `storage/fs/` (Node-only)
and the tests (`__tests__/`, `*.test.ts`), renames files to kebab-case
with their relative imports, formats the result, and updates the commit above.

Import it through `@decocms/shared/blocks-protocol`,
`@decocms/shared/blocks-protocol/server`,
`@decocms/shared/blocks-protocol/storage/memory` and
`@decocms/shared/blocks-protocol/conformance`. Once `@decocms/blocks@8` is
published, depend on it, point those imports at `@decocms/blocks/protocol*`
and delete this folder: the layout is the same.
