# Build the Studio (mesh) Docker image from a locally-built artifact

**Date:** 2026-06-02
**Status:** Approved (design) — pending spec review → implementation plan
**Scope:** `.github/workflows/release-mesh.yaml`, `apps/mesh/Dockerfile`

## Problem

The `Release Mesh` workflow's `build-docker` job installs the package from the
**npm registry** (`apps/mesh/Dockerfile`: `RUN bun add decocms@${MESH_VERSION}`).
PR #3635 ("parallel npm") removed `build-docker`'s dependency on `publish-npm`
on the incorrect assumption that the Dockerfile "installs from the workspace,
never from the npm registry." Because the Dockerfile actually reads from the
registry, decoupling the two jobs created a race: the Docker build reaches
`bun add` before `publish-npm` has published + propagated the version, and fails
with:

```
error: No version matching "<version>" found for specifier "decocms"
```

This broke Studio image builds at 2.381.2 and 2.382.0. PR #3640 (merged) restored
`build-docker`'s `needs: publish-npm` as a minimal fix — correct, but it serializes
the Docker build after the npm publish + a propagation-wait, losing the parallelism
#3635 wanted.

This design removes the npm-registry dependency from the image build **entirely**,
restoring true parallelism without reintroducing the race, while keeping the
container image **byte-identical** to the published npm package.

## Goals

- **Parity**: the Docker image and `bunx @decocms/mesh@X` install the *exact same
  bytes*. The image must never diverge from the published npm artifact.
- **No registry race**: the image build must not depend on npm-registry
  availability/propagation of the version being released.
- **Parallelism**: `publish-npm` and `build-docker` run concurrently (recover the
  ~1–2 min #3635 targeted).
- **Low risk**: minimal Dockerfile change; multi-arch behavior and runtime
  unchanged; easy rollback.

## Non-goals

- Stop publishing to npm. The npm package remains the primary distribution for
  `bunx` users; this change is about how the *image* sources the package.
- Change the bundle/build pipeline (`prepublishOnly`, `bundle-server-script.ts`).
- Change the multi-arch topology (single-job QEMU multi-arch stays).
- Reduce image size or change the runtime/base image.

## Background — how the package is built and consumed today

- `apps/mesh/package.json`: `name: decocms`, `bin.deco: ./dist/server/cli.js`,
  `files: ["dist/**/*"]`, `prepublishOnly: build:client && build:server`.
- `build:server` (`apps/mesh/scripts/bundle-server-script.ts`): builds the sandbox
  daemon, traces deps with `@vercel/nft`, inlines `@decocms/*` workspace packages,
  externalizes the rest into `dist/server/node_modules/`, and emits minified
  `server.js` / `cli.js` / `migrate.js`. Only `dist/**` ships.
- `publish-npm` job: `bun install` → `npm publish --provenance` (publish triggers
  `prepublishOnly`), then a "Wait for npm propagation" loop.
- `build-docker` job: `docker build` with context `./apps/mesh`; the Dockerfile
  does `bun add decocms@${MESH_VERSION}`, which downloads the published tarball and
  installs its declared `dependencies`, compiling `node-pty` from source per-arch
  (hence `python3` + `build-essential` in the image).

## Design

### Chosen approach

Build the package **once** as the exact tarball npm serves (`npm pack`), share it
between jobs as a workflow artifact, and have the image install **that local
tarball** instead of pulling from the registry.

Considered and rejected:
- *Rebuild from source inside Docker* — breaks byte-parity with npm (two
  independent builds); fails the parity goal.
- *Image consumes extracted `dist/` + synthesized `package.json` + `bun install`* —
  more moving parts and divergence risk than installing the packed tgz, with no
  upside.

### New job graph

```
prepare ──┬─> build-dist ──┬─> publish-npm   (publish the tgz)        ┐
          │                └─> build-docker  (bun add ./tgz, push)    ├─> release
          │                                                            ┘
          └─────────────────────────────────────────> bump-deco-apps-cd
```

- **`build-dist`** (new job):
  - `needs: prepare`
  - `if: version-changed == 'true' || image-exists == 'false'` (build only when a
    publish or an image is needed).
  - Steps: checkout (pinned to `inputs.ref`) → `oven-sh/setup-bun` →
    `bun install` → `cd apps/mesh && npm pack` → upload `apps/mesh/decocms-*.tgz`
    as artifact `mesh-package`.
- **`publish-npm`**:
  - `needs: [prepare, build-dist]`
  - `if: version-changed == 'true' && build-dist succeeded`
  - Steps: download `mesh-package` artifact →
    `npm publish decocms-*.tgz --access public --tag <npm-tag> --provenance`.
  - **Remove** the "Wait for npm propagation" step (its only consumer was the
    registry read in `build-docker`).
- **`build-docker`**:
  - `needs: [prepare, build-dist]` (**not** `publish-npm`)
  - `if: always() && image-exists == 'false' && (needs.build-dist.result == 'success')`
  - Steps: download `mesh-package` artifact into the build context as `decocms.tgz`
    → `docker/build-push-action` (multi-arch, QEMU) with the Dockerfile installing
    the local tgz.
  - Runs **in parallel** with `publish-npm`.
- **`release`** and **`bump-deco-apps-cd`**: add `build-dist` to `needs`; preserve
  the existing guards (`publish-npm` success-or-skipped; valid image exists). The
  intent — never promote an image whose npm artifact failed — is unchanged.

### Dockerfile change

Context changes from `./apps/mesh` to a minimal context containing the Dockerfile +
the downloaded `decocms.tgz` (the monorepo is no longer needed at image-build time).

```dockerfile
# was: RUN bun add decocms@${MESH_VERSION}
COPY decocms.tgz /tmp/decocms.tgz
RUN bun add /tmp/decocms.tgz
```

`MESH_VERSION` build-arg may be dropped (or kept only for image labels). Everything
else is unchanged: `oven/bun:1-slim` base, `unzip`/`python3`/`build-essential` for
`node-pty`, toolchain purge, non-root user, `CMD ["bun","run","deco",...]`.

### Why this satisfies the goals

- **Parity**: `publish-npm` and `build-docker` install the *same* `decocms-*.tgz`
  artifact. The container and `bunx @decocms/mesh@X` are byte-identical.
- **No race**: the image build performs no registry read for the version being
  released; it can never lose a propagation race.
- **Parallelism**: both consumers gate only on `build-dist`, so they run
  concurrently.
- **Low risk**: the install path (`bun add <pkg>` → compile `node-pty` per-arch) is
  unchanged in kind; only the package source moves from registry to local file.

## Edge cases

| Scenario | build-dist | publish-npm | build-docker | Result |
|---|---|---|---|---|
| Normal release (new version, no image) | runs | publishes | builds (∥) | ✅ release |
| Re-run / unblock (version on npm, image missing) | runs | skipped | builds from fresh tgz | ✅ image; parity holds (same source SHA) |
| Version published, image already in GHCR | skipped | skipped | skipped | ✅ no-op |
| `build-dist` fails | failed | skipped | skipped | ❌ nothing shipped (correct) |

## Risks & validation

1. **Provenance**: `npm publish <prebuilt-tgz> --provenance` must still attach a
   valid provenance attestation (the `pack`-then-`publish` split is supported; npm
   generates provenance from the tarball + workflow OIDC at publish time).
   **Validate** by publishing a `-alpha` prerelease on the `next` tag and confirming
   the provenance statement appears.
2. **`bun add ./local.tgz`** must resolve + compile the declared `dependencies`
   (incl. `node-pty`) identically to `bun add decocms@X`. **Validate** by building
   the image and booting it (`deco --no-tui --no-local-mode` starts; migrations run).
3. **Artifact transfer**: the tgz is ~48 MB; upload/download between jobs adds a few
   seconds but removes the publish→propagate wait from the critical path. Acceptable.
4. **arm64 under QEMU**: unchanged from today (only `node-pty` compile runs emulated;
   it was already deemed "small enough").

## Testing

- **Dry-run prerelease**: cut a `-alpha.N` version (→ `next` tag) and run the full
  workflow; confirm: tgz artifact produced once; publish + docker run in parallel;
  provenance attached; image pulls and boots; deco-apps-cd bump fires.
- **Re-run path**: dispatch with `ref` pinned to an already-published version and a
  missing image; confirm publish skips, build-dist + build-docker produce a working
  image.
- **Parity check (optional, strong)**: extract `node_modules/decocms` from the built
  image and diff against the published tarball contents — expect identical files.

## Rollback

Pure CI + Dockerfile change; no runtime, schema, or data impact. Revert by restoring
`RUN bun add decocms@${MESH_VERSION}`, the `./apps/mesh` build context, and
`build-docker`'s `needs: [prepare, publish-npm]`. Validatable on a prerelease before
any production release.
