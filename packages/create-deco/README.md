# create-deco

Provides the public bootstrap command for creating a deco MCP application.

| Attribute | Value |
| --- | --- |
| Workspace | `create-deco` (`packages/create-deco`) |
| Kind | CLI bootstrapper |
| Runtime | Node.js 22+ or Bun |
| Distribution | Public npm package |

## Overview

`create-deco` is the package behind `npm create deco` and `bun create deco`.
It forwards the requested project directory to `decocms init`, which clones the
`decocms/mcp-app` template and installs its dependencies.

## Responsibilities

- Expose the `create-deco` executable.
- Require a project-directory argument.
- Select `bunx` when running under Bun and `npx` otherwise.
- Forward standard input, output, errors, working directory, and exit status to
  the `decocms` CLI.

## Usage

Create a project with Bun:

```bash
bun create deco my-mcp-app
```

Or use npm:

```bash
npm create deco my-mcp-app
```

The package has no JavaScript import API. Its supported public surface is the
`create-deco` executable declared in `package.json`.

## Architecture

`index.js` is a small CommonJS launcher. It reads the first positional argument
as the project name and starts either:

```text
bunx decocms init <project-name>
```

or:

```text
npx decocms init <project-name>
```

The `decocms` CLI owns template retrieval, empty-directory validation, and
dependency installation.

## Development

Run a manual smoke test from the repository root:

```bash
bun run packages/create-deco/index.js my-mcp-app
```

Use a disposable directory because the command creates files and installs
dependencies. This package currently has no build, type-check, or automated test
script.

## Boundaries

Keep this package as a thin compatibility launcher. Template content,
scaffolding policy, dependency installation, and user guidance after creation
belong to the `decocms init` implementation.

Do not add Studio server logic, web code, or a second implementation of the
scaffolding workflow here. Do not document deep imports: this package exposes a
binary only.

## Related documentation

- [Studio repository overview](../../README.md)
- [`decocms init` implementation](../../apps/api/src/cli/commands/init.ts)
- [MCP app template](https://github.com/decocms/mcp-app)
