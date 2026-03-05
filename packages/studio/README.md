# decocms

CLI wrapper for `@decocms/mesh` — the Deco Studio MCP Gateway.

## Usage

```bash
# Run directly
npx decocms

# Or install globally
npm i -g decocms
deco
```

## Why this exists

The product is being rebranded from "MCP Mesh" to "Deco Studio". During the
transition both npm packages need to work:

- `bunx @decocms/mesh` — canonical package (all source code lives here)
- `npx decocms` / `deco` — user-facing CLI that depends on `@decocms/mesh`

This lets marketing materials and docs reference `npx decocms` immediately
without renaming the main package or breaking existing installs.

## How it works

- `package.json` declares `@decocms/mesh` as a dependency (pinned to the same version)
- `bin/deco.js` simply imports the mesh CLI entry point
- Both packages are published with the same version number

## Eventually

Once the rename is complete, `@decocms/mesh` will become the wrapper (pointing
to `decocms`) and all source code will move under the decocms name.
