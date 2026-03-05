# @decocms/studio

Transitional wrapper package for `@decocms/mesh`.

## Why this exists

The product is being rebranded from "MCP Mesh" to "Deco Studio". During the
transition both npm package names need to work:

- `bunx @decocms/mesh` — canonical package (all source code lives here)
- `bunx @decocms/studio` — alias that depends on `@decocms/mesh` and
  re-exports its CLI bin

This lets marketing materials and docs reference `@decocms/studio` immediately
without renaming the main package or breaking existing installs.

## How it works

- `package.json` declares `@decocms/mesh` as a dependency (pinned to the same version)
- `bin/studio.js` simply imports the mesh CLI entry point
- Both packages are published with the same version number

## Eventually

Once the rename is complete, `@decocms/mesh` will become the wrapper (pointing
to `@decocms/studio`) and all source code will move under the studio name.
