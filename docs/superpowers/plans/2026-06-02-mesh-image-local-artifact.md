# Build the mesh image from a local artifact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `decocms` package once in CI, share it as a workflow artifact, publish that exact tarball to npm AND install it in the Docker image — removing the npm-registry dependency (and the propagation race) from the image build, restoring publish/Docker parallelism, and keeping the image byte-identical to the published package.

**Architecture:** Add a `build-dist` job that runs `npm pack` and uploads `decocms-<version>.tgz`. `publish-npm` publishes that tarball; `build-docker` installs it via `bun add /tmp/decocms.tgz` (Dockerfile change). Both consumers gate only on `build-dist`, so they run in parallel. No job reads the npm registry for the version being released.

**Tech Stack:** GitHub Actions, `actions/upload-artifact@v4` / `download-artifact@v4`, `docker/build-push-action@v5`, Bun, npm, the `oven/bun:1-slim` Docker base.

**Spec:** `docs/superpowers/specs/2026-06-02-mesh-image-local-artifact-design.md`

---

## File Structure

- **Modify** `.github/workflows/release-mesh.yaml` — add `build-dist`; rewire `publish-npm`, `build-docker`, `release`, `bump-deco-apps-cd`.
- **Modify** `apps/mesh/Dockerfile` — install the local tarball instead of `bun add decocms@<version>`.

No new files. No runtime/source/schema changes.

## Per-commit CI-green ordering (important)

Each task is a self-contained, CI-green commit. Order matters:

1. **Task 1** adds `build-dist` (additive — produces an artifact nothing consumes yet).
2. **Task 2** switches the *image* to the artifact (Dockerfile + `build-docker` + downstream gating). Must be one commit: the Dockerfile alone would break CI because `build-docker`'s context wouldn't contain `decocms.tgz`.
3. **Task 3** switches *npm publish* to the same artifact and removes the now-dead propagation wait. (The wait must survive until Task 2 lands — while `build-docker` still read the registry in earlier states, dropping it would reintroduce the race.)
4. **Task 4** validates locally; **Task 5** opens the PR and runs the prerelease dry-run.

## Lint helper (used in several tasks)

Validate the workflow with `actionlint` (catches `needs`/expression/syntax errors). If it isn't installed, this Docker one-liner runs it (the repo already builds Docker):

```bash
docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/release-mesh.yaml
```
Expected: no output, exit code 0.

---

### Task 1: Add the `build-dist` job

**Files:**
- Modify: `.github/workflows/release-mesh.yaml` (insert a new job between `prepare` and `publish-npm`, i.e. after the `prepare` job ends at line 84, before `publish-npm:` at line 86)

- [ ] **Step 1: Insert the `build-dist` job**

Insert this block immediately before the `  publish-npm:` line (currently line 86):

```yaml
  # Build the npm tarball EXACTLY ONCE, then hand it to both publish-npm and
  # build-docker as a workflow artifact. `npm pack` does not run prepublishOnly,
  # so we build the bundles explicitly first (build:client + build:server), then
  # pack. Sharing one tarball is what guarantees the Docker image and the
  # published npm package are byte-identical.
  build-dist:
    name: Build package artifact
    needs: prepare
    if: |
      needs.prepare.outputs.version-changed == 'true' ||
      needs.prepare.outputs.image-exists == 'false'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref }}
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - name: Install dependencies
        run: bun install
      - name: Build client + server bundles
        run: |
          bun run --cwd=apps/mesh build:client
          bun run --cwd=apps/mesh build:server
      - name: Pack the npm tarball
        working-directory: apps/mesh
        run: npm pack
      - name: Upload package artifact
        uses: actions/upload-artifact@v4
        with:
          name: mesh-package
          path: apps/mesh/decocms-*.tgz
          if-no-files-found: error
          retention-days: 1

```

- [ ] **Step 2: Lint the workflow**

Run the lint helper above.
Expected: exit 0, no errors. (`build-dist` references only `needs.prepare.outputs.*`, which exist.)

- [ ] **Step 3: Sanity-check the build+pack locally**

This proves the build-then-pack sequence produces a tarball (run from repo root):

```bash
bun install
bun run --cwd=apps/mesh build:client
bun run --cwd=apps/mesh build:server
(cd apps/mesh && npm pack)
ls -1 apps/mesh/decocms-*.tgz
```
Expected: prints a path like `apps/mesh/decocms-2.382.1.tgz`. Clean it up: `rm apps/mesh/decocms-*.tgz`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-mesh.yaml
git commit -m "$(cat <<'EOF'
ci(release-mesh): add build-dist job that packs the npm tarball once

Builds the bundles and runs `npm pack` a single time, uploading
decocms-<version>.tgz as a workflow artifact. Nothing consumes it yet;
publish-npm and build-docker are wired to it in following commits so the
image and the published package come from one identical tarball.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Switch the image to the local artifact

This is one commit (Dockerfile + `build-docker` + downstream gating are interdependent).

**Files:**
- Modify: `apps/mesh/Dockerfile` (lines 5-6 and 27-28)
- Modify: `.github/workflows/release-mesh.yaml` (`build-docker` job lines 122-180; `release` `needs`/`if` lines 184-189; `bump-deco-apps-cd` `needs`/`if` lines 255 and 265-271)

- [ ] **Step 1: Edit the Dockerfile — replace the version ARG comment**

Replace lines 5-6:

```dockerfile
# Version to install (override with --build-arg MESH_VERSION=1.0.0)
ARG MESH_VERSION=latest
```

with:

```dockerfile
# The package tarball is built once by CI (build-dist job) and dropped into the
# build context as decocms.tgz. Installing that exact tarball keeps this image
# byte-identical to `bunx @decocms/mesh@<version>` and avoids any npm-registry
# round-trip (and propagation race) at image-build time.
```

- [ ] **Step 2: Edit the Dockerfile — install the local tarball**

Replace lines 27-28:

```dockerfile
# Install the package locally during build (cached in image layer)
RUN bun add decocms@${MESH_VERSION}
```

with:

```dockerfile
# Install the locally-built package tarball (provided via the build context).
COPY decocms.tgz /tmp/decocms.tgz
RUN bun add /tmp/decocms.tgz
```

- [ ] **Step 3: Validate the Dockerfile install path locally (fast, no Docker)**

Confirms `bun add <local tgz>` resolves the package + its deps and the `deco` bin works — the core risk of the change. From repo root:

```bash
bun install
bun run --cwd=apps/mesh build:client
bun run --cwd=apps/mesh build:server
(cd apps/mesh && npm pack)
TGZ="$(ls "$PWD"/apps/mesh/decocms-*.tgz)"
TMP="$(mktemp -d)"; cd "$TMP"
bun add "$TGZ"
bun run deco --help
```
Expected: `bun add` completes (compiles `node-pty`), and `deco --help` prints CLI usage. Clean up: `cd - && rm -rf "$TMP" apps/mesh/decocms-*.tgz`.

- [ ] **Step 4: Replace the `build-docker` job**

Replace the entire `build-docker` block (the comment at lines 122-131 plus the job at lines 132-180) with:

```yaml
  # Single-job multi-arch build. Pushes the final tagged manifest directly to
  # GHCR. arm64 is built under QEMU on an amd64 runner; only node-pty compiles
  # natively, which is small enough to keep the simpler topology.
  # Consumes the tarball built by build-dist (NOT the npm registry): the
  # Dockerfile does `bun add /tmp/decocms.tgz`, so there is no registry read to
  # race against publish-npm. Runs in PARALLEL with publish-npm — both gate only
  # on build-dist and install the same tarball, so the image stays byte-identical
  # to the published package.
  build-docker:
    name: Build & push Docker (multi-arch)
    needs: [prepare, build-dist]
    if: |
      always() &&
      needs.prepare.outputs.image-exists == 'false' &&
      needs.build-dist.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref }}
      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Download package artifact into build context
        uses: actions/download-artifact@v4
        with:
          name: mesh-package
          path: docker-context
      - name: Normalize tarball filename
        run: mv docker-context/decocms-*.tgz docker-context/decocms.tgz
      - name: Extract metadata (tags, labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}},value=${{ needs.prepare.outputs.version }}
            type=semver,pattern={{major}}.{{minor}},value=${{ needs.prepare.outputs.version }}
            type=raw,value=latest
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ./docker-context
          file: ./apps/mesh/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=mesh
          cache-to: type=gha,mode=max,scope=mesh
```

Note the changes vs. the original: `needs` drops `publish-npm` and adds `build-dist`; the `if` gates on `build-dist` success instead of `publish-npm`; two new steps download the artifact + normalize its name; `context` becomes `./docker-context` (the Dockerfile stays at `./apps/mesh/Dockerfile`); the `MESH_VERSION` build-arg is removed.

- [ ] **Step 5: Update `release` job `needs` and `if`**

In the `release` job, replace:

```yaml
    needs: [prepare, publish-npm, build-docker]
    if: |
      always() &&
      (needs.prepare.outputs.version-changed == 'true' || needs.prepare.outputs.image-exists == 'false') &&
      (needs.publish-npm.result == 'success' || needs.publish-npm.result == 'skipped') &&
      (needs.build-docker.result == 'success' || needs.build-docker.result == 'skipped')
```

with:

```yaml
    needs: [prepare, build-dist, publish-npm, build-docker]
    if: |
      always() &&
      (needs.prepare.outputs.version-changed == 'true' || needs.prepare.outputs.image-exists == 'false') &&
      (needs.build-dist.result == 'success' || needs.build-dist.result == 'skipped') &&
      (needs.publish-npm.result == 'success' || needs.publish-npm.result == 'skipped') &&
      (needs.build-docker.result == 'success' || needs.build-docker.result == 'skipped')
```

(If `build-dist` fails, `publish-npm`/`build-docker` are skipped and the new clause makes `release` skip too — no release for an unbuilt version.)

- [ ] **Step 6: Update `bump-deco-apps-cd` job `needs` and `if`**

In the `bump-deco-apps-cd` job, replace:

```yaml
    needs: [prepare, publish-npm, build-docker]
```
with:
```yaml
    needs: [prepare, build-dist, publish-npm, build-docker]
```

and replace its `if` block:

```yaml
    if: |
      always() &&
      (needs.publish-npm.result == 'success' || needs.publish-npm.result == 'skipped') &&
      (
        needs.prepare.outputs.image-exists == 'true' ||
        needs.build-docker.result == 'success'
      )
```

with:

```yaml
    if: |
      always() &&
      (needs.build-dist.result == 'success' || needs.build-dist.result == 'skipped') &&
      (needs.publish-npm.result == 'success' || needs.publish-npm.result == 'skipped') &&
      (
        needs.prepare.outputs.image-exists == 'true' ||
        needs.build-docker.result == 'success'
      )
```

- [ ] **Step 7: Lint the workflow**

Run the lint helper.
Expected: exit 0. Confirm no reference to `needs.publish-npm` remains inside `build-docker`, and every job that uses `needs.build-dist.*` lists `build-dist` in its `needs`.

- [ ] **Step 8: Commit**

```bash
git add apps/mesh/Dockerfile .github/workflows/release-mesh.yaml
git commit -m "$(cat <<'EOF'
ci(release-mesh): build the image from the local tarball, parallel to npm

build-docker now installs the build-dist tarball (`bun add /tmp/decocms.tgz`)
instead of `bun add decocms@<version>` from the npm registry. It depends on
build-dist (not publish-npm) and runs in parallel with the publish. release
and bump-deco-apps-cd gain a build-dist guard so a failed build ships nothing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Publish the shared artifact from `publish-npm`

Now that `build-docker` no longer reads the registry, point `publish-npm` at the same tarball and delete the dead propagation wait.

**Files:**
- Modify: `.github/workflows/release-mesh.yaml` (`publish-npm` job, lines 86-120)

- [ ] **Step 1: Replace the `publish-npm` job**

Replace the entire `publish-npm` job (lines 86-120) with:

```yaml
  publish-npm:
    name: Publish to NPM
    needs: [prepare, build-dist]
    if: needs.prepare.outputs.version-changed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
      - name: Download package artifact
        uses: actions/download-artifact@v4
        with:
          name: mesh-package
      - name: Publish to NPM
        run: npm publish decocms-*.tgz --access public --tag ${{ needs.prepare.outputs.npm-tag }} --provenance
```

Changes vs. original: `needs` adds `build-dist`; the checkout / `setup-bun` / `bun install` steps are gone (no build — we publish the prebuilt tarball); the publish step publishes the downloaded `decocms-*.tgz`; the "Wait for npm propagation" step is removed (nothing downstream reads the registry now). `id-token: write` and `--provenance` are preserved so provenance is still attached.

- [ ] **Step 2: Lint the workflow**

Run the lint helper.
Expected: exit 0.

- [ ] **Step 3: Confirm no propagation wait or registry read remains**

```bash
grep -n "Wait for npm propagation\|npm view decocms" .github/workflows/release-mesh.yaml
```
Expected: only the line inside the `prepare` job (`if npm view decocms@$CURRENT_VERSION ...`) — that read is for the version-changed check and is correct to keep. No match inside `publish-npm` or `build-docker`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-mesh.yaml
git commit -m "$(cat <<'EOF'
ci(release-mesh): publish the build-dist tarball, drop propagation wait

publish-npm now downloads and publishes the exact tarball build-docker
installs, guaranteeing the image and the npm package are byte-identical.
The npm-propagation wait is removed — no job reads the registry for the
version being released anymore.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full local end-to-end image validation (optional but recommended)

Builds the real image from a locally-packed tarball using the same context layout CI uses, and boots it. Slower (full apt + `bun add` + native compile), so it's separate from the fast check in Task 2.

**Files:** none (validation only)

- [ ] **Step 1: Pack and assemble the build context**

From repo root:

```bash
bun install
bun run --cwd=apps/mesh build:client
bun run --cwd=apps/mesh build:server
(cd apps/mesh && npm pack)
rm -rf /tmp/docker-context && mkdir -p /tmp/docker-context
cp apps/mesh/decocms-*.tgz /tmp/docker-context/decocms.tgz
```

- [ ] **Step 2: Build the image (amd64, native)**

```bash
docker build -f apps/mesh/Dockerfile -t mesh-local-test /tmp/docker-context
```
Expected: build succeeds; the `bun add /tmp/decocms.tgz` layer resolves and compiles `node-pty`.

- [ ] **Step 3: Boot-check the image**

```bash
docker run --rm mesh-local-test bun run deco --help
```
Expected: prints the `deco` CLI help (the bundled `dist/server/cli.js` runs).

- [ ] **Step 4: Clean up**

```bash
docker rmi mesh-local-test; rm -rf /tmp/docker-context apps/mesh/decocms-*.tgz
```

No commit (validation only).

---

### Task 5: Open the PR and run the prerelease dry-run

**Files:** none (PR + CI validation)

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin tlgimenes/mesh-image-local-artifact
gh pr create --base main --title "ci(release-mesh): build the Studio image from a local artifact" \
  --body "Implements docs/superpowers/specs/2026-06-02-mesh-image-local-artifact-design.md. build-dist packs the tarball once; publish-npm and build-docker consume it in parallel (no npm-registry read in the image build), keeping the image byte-identical to the published package. Follow-up to #3640 (which serialized the jobs as a minimal race fix)."
```

- [ ] **Step 2: Dispatch a prerelease dry-run**

A `-alpha` version publishes to the `next` tag (per `prepare`'s npm-tag logic) and is marked prerelease, so it won't disturb `latest` consumers. On a scratch branch, bump `apps/mesh/package.json` version to e.g. `2.382.2-alpha.1`, push, and either let the push trigger fire or dispatch:

```bash
gh workflow run release-mesh.yaml --ref <scratch-branch> -f ref=<scratch-sha>
```

- [ ] **Step 3: Confirm the dry-run**

Watch the run (`gh run watch <id> --exit-status`) and verify:
- `build-dist` succeeds and uploads `mesh-package`.
- `publish-npm` and `build-docker` run **concurrently** (overlapping start times) — both `needs: build-dist`, neither waits on the other.
- `publish-npm` publishes with **provenance** (log shows "Provenance statement published…").
- `build-docker` pushes a working multi-arch image; pull and boot it:
  `docker run --rm ghcr.io/decocms/studio/mesh:2.382.2-alpha.1 bun run deco --help`.
- **Parity spot-check:** the published `next` tarball equals the image's installed package:
  ```bash
  npm pack decocms@2.382.2-alpha.1
  docker run --rm ghcr.io/decocms/studio/mesh:2.382.2-alpha.1 \
    sh -c 'cd node_modules/decocms && find dist -type f | sort | head' 
  ```
  Expected: the image's `dist` file list matches the published tarball's contents.
- Note the `type=raw,value=latest` tag is pre-existing behavior; for the alpha dry-run, prefer pulling by the explicit `2.382.2-alpha.1` tag and do not promote `latest`.

- [ ] **Step 4: Clean up the dry-run**

Deprecate the alpha if desired (`npm deprecate decocms@2.382.2-alpha.1 "dry-run"`), delete the scratch branch, and delete the alpha GHCR tag if your registry policy requires.

---

## Self-Review

**Spec coverage:**
- Parity (one tarball → both consumers) → Tasks 1 (pack once), 2 (image installs it), 3 (npm publishes it). ✅
- No registry race → Task 2 (Dockerfile `bun add` local tgz; `build-docker` drops `publish-npm` dep) + Task 3 (wait removed). ✅
- Parallelism (`build-dist → publish-npm ∥ build-docker`) → Tasks 2 & 3 (`needs` rewired). ✅
- Edge-case matrix (normal / re-run / already-built / build-dist failure) → Task 2 Steps 5-6 gating + the `if` conditions. ✅
- Provenance + node-pty validation → Tasks 2 (fast bun check), 4 (image boot), 5 (provenance + parity). ✅
- Rollback → revert Tasks 2-3 commits; covered by per-task atomic commits.

**Placeholder scan:** Dry-run version/branch/sha (`2.382.2-alpha.1`, `<scratch-branch>`, `<scratch-sha>`) are intentionally chosen at run time, not code placeholders. All YAML/Dockerfile steps contain complete content.

**Type/identifier consistency:** artifact name `mesh-package` (upload Task 1; download Tasks 2 & 3); tarball glob `decocms-*.tgz` → normalized to `decocms.tgz` in the image context (Task 2 normalize step + Dockerfile `COPY decocms.tgz`); job id `build-dist` consistent across all `needs`/`if`; `build-dist.result` referenced only by jobs that list `build-dist` in `needs`.
