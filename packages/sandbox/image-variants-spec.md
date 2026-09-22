# Sandbox image variants

Status: proposal. Supersedes the shape of #7461 (`feat(sandbox): per-repository
sandbox image, with an Android emulator variant`). The runtime half of that PR stands; the
ownership of images and templates moves out of this repo, into a new
**sandbox control plane** (`decocms/sandbox-control-plane`, to be created).
The hosting control-plane (`decocms/control-plane`) is the pattern, not the
host: it stays site-shaped, and the sandbox one is its own service.

## Problem

Some repositories need a toolchain the default sandbox image does not carry.
First case: a customer's Flutter mobile app. Its transitive dependencies do
not compile to JS (`xxh3` for dart2js, `get_storage` for dart2wasm), and its
startup calls native-only plugins (Firebase, attribution and push SDKs) that
neither the web nor the Linux desktop target can run — and the app is not ours
to change. The only way to QA it unmodified is an Android emulator: ~6GB of
SDK and system image, and `/dev/kvm`, which only nodes launched with nested
virtualization have. Putting that on the image every sandbox pulls, or on
every sandbox node, slows and constrains everyone for one kind of repo.

Two constraints from the first case that generalise:

1. **A variant can need its own hardware.** `android` needs KVM, so a
   variant is an image PLUS where it may run (node selector, tolerations, a
   device request) and how big it is.
2. **A variant is customer-shaped.** It must stay compatible with the
   customer's own Dockerfile (Flutter version, native deps). When they bump,
   we bump.
3. **New variants will keep appearing.** Adding one must not need a Studio
   deploy, a Studio PR, a sandbox release-workflow change, or a Helm values
   PR per environment.

## Non-goals

- A per-repo Dockerfile built at boot (devcontainer model). Too slow per boot,
  and the daemon's runtime contract is too wide to layer onto an arbitrary
  customer base today. Recorded as the ceiling in [Later](#later).
- Per-org or per-thread images. The primary repository decides; one pod, one
  toolchain.
- Moving the *default* template and pools out of the `sandbox-env` chart in
  this step. That is the natural next move once variants prove the path
  (see [Later](#later)).

## Design

A new service, the sandbox control plane, becomes the authority for what the
sandbox clusters run: which images exist, which templates and pools each
cluster renders, and later which claims are open. It borrows the hosting
control-plane's shape (`decocms/control-plane`, docs/ARCHITECTURE.md): render
is a pure function, apply is a seam, an MCP surface Studio can embed. It does
not borrow its state model in the first slice (see [Why no database yet](#why-no-database-yet)).

| owner | owns | changes when |
|---|---|---|
| `decocms/studio` | base image, daemon, template-name composition, `repositories.sandbox_image` | never, for a new variant |
| `decocms/sandbox-control-plane` | image catalog → `SandboxTemplate`/`SandboxWarmPool` per cluster, `SANDBOX_IMAGE_*` tools, console | a variant is added, retagged, prewarmed |
| `deco-cx/infra_applications` | `sandbox-images/<variant>/Dockerfile` + CI + smoke test | a variant's toolchain changes |
| `deploy/helm/sandbox-env` (studio) | operator RBAC, default template + pools, gateway, housekeeper — unchanged in this slice | — |

### Studio

Keep from #7461:

- `repositories.sandbox_image` (migration 224), `NULL` = default.
- `EnsureOptions.sandboxImage`, persisted with the claim so a resurrected
  claim lands on the same image.
- Template name `<base>-<variant>[-medium]`, probed per name with the existing
  TTL cache, degrading to the base template with a warning when the cluster
  does not render it.
- A non-default image opts out of tenant pools (built from the default image).

Change from #7461:

- **`sandbox_image` is a plain string**, not a `z.enum`. Validate shape only:
  `/^[a-z][a-z0-9-]{0,31}$/`. The probe already protects the claim from a
  name the cluster lacks, which was the enum's only justification. Studio
  never learns the word `flutter`.
- **The picker lists what the cluster renders.** Settings → Repositories
  offers `SandboxTemplate`s matching `<base>-*` (minus `-medium`), read
  through the same probe path and cached with the same TTL. Empty list = the
  field is hidden. Studio does not call the control-plane for this: the
  cluster is the truth the claim will hit, and Studio already has the client.
- **Auto-select on link.** `REPOSITORY_LINK` sets `sandbox_image` from a
  detection table when the field is not given; `REPOSITORY_UPDATE` still
  overrides. First entry: root `pubspec.yaml` plus an `android/` project → `android`. One contents API
  call at link time. The detected name still goes through the probe.
- Delete: `SandboxImageSchema`, the picker's i18n option strings,
  `packages/sandbox/image-android/`, the `build-push-android` job, the
  `needs: build-push-android` on the deco-apps-cd bump, and the
  `imageVariants` block in `deploy/helm/sandbox-env` (the chart renders the
  default templates only; variants are control-plane state).

### Base image

Flutter content in `packages/sandbox/image/Dockerfile` (SDK clone, precache,
pub-cache) moves to the variant once the variant is live. The base gets
lighter for everyone and Flutter has one home, where its version can follow
the customer. `skills/flutter-app/SKILL.md` moves with it.

Sequencing: base keeps the SDK until the variant has served real runs for one
release; then one PR removes it.

### Sandbox control plane

**Repo** `decocms/sandbox-control-plane`. Bun + `@decocms/runtime` MCP server,
React console, Biome, `bun test`, same stack as the hosting control-plane so
the scaffold, auth resolver and Studio-embed wiring are copied, not designed.
Go is the alternative (the operator and daemon are Go); rejected for the first
slice because the Studio-embedded MCP/UI path is proven in TS and this
service is mostly that surface.

**Deployment.** One Deployment **per sandbox cluster**, in-namespace with the
operator, running as a ServiceAccount whose Role covers
`extensions.agents.x-k8s.io` `sandboxtemplates` and `sandboxwarmpools`
(get/list/watch/create/patch/delete) and nothing else. No kubeconfig, no
cross-cluster credential. "Global" is the console, not the process: the
console lists every cluster's instance and each instance answers for its own
cluster. ArgoCD app in deco-apps-cd, immutable tag, same as everything else.

**Applier.** `direct-apply` through the in-cluster API, create-if-absent else
merge-patch. The seam exists (one interface, one implementation) so the
hosting model — desired rows plus a dial-out agent — can replace it if the
control plane ever needs to run outside the cluster it manages. That is a
`ponytail:` on purpose: two implementations when the second one is needed.

**Catalog and render.** A variant is a `SandboxTemplate` named
`<base>-<name>` carrying the label `sandbox.deco.cx/variant=<name>` and the
annotation `sandbox.deco.cx/base-tag`, plus its `-medium`
twin and two `SandboxWarmPool`s at size 0 by default. The render is a pure
function `(variant, defaultTemplate) → [4 objects]`: everything except
`image` is copied from the cluster's **default** `SandboxTemplate` (read live),
so a variant cannot differ in resources, security context or mounts. Size-0
pools are rendered rather than omitted so prewarming is an `UPSERT`, not a
new object.

**Tools** (MCP; REST mirror under `/api/v1` for CI):

- `SANDBOX_IMAGE_LIST` — variants on this cluster, from the labelled templates.
- `SANDBOX_IMAGE_UPSERT { name, repository, tag, baseTag, nodeSelector?,
  tolerations?, resources?, warmPool? }` — renders and applies the four
  objects; the scheduling fields are what a hardware-bound variant (`android`:
  KVM nodes, a `/dev/kvm` device request) needs. Rejects `latest`. Does a registry
  `HEAD` on `repository:tag` first and refuses a tag that does not exist:
  the template existing while the image does not is `ImagePullBackOff`, not
  a Studio degrade, so this is the one check worth doing here.
- `SANDBOX_IMAGE_TAG_SET { name, tag, baseTag }` — what CI calls.
- `SANDBOX_IMAGE_DELETE { name }` — deletes the four objects. Studio's probe
  then degrades repos still pinned to it, which is the designed behaviour.

**Auth.** Copied from hosting: admin bearer (constant-time) for the console
and humans; one service token per env for infra_applications' CI, its sha256
in a mounted Secret (no database to keep it in); Studio per-request JWT (`@deco.cx` ⇒ admin) the day Studio
embeds the console. No tenant role in this slice: nothing here is per-org.

**Console.** One table: name, repository:tag, base tag, default template's
image tag (so the skew is one glance), pools, last apply time. Embedded in
Studio through the same `_meta.ui.resourceUri` mechanism the hosting console
uses, when that is wanted; standalone first.

### Interfaces with Studio

**None at runtime, in this slice.** The two services meet only in the
cluster: the control plane writes `SandboxTemplate` objects, Studio's probe
reads them and composes the claim's template name. Studio does not know the
control plane exists; the control plane does not know which repositories
pinned which variant. This is deliberate: it lets each ship without a deploy
order against the other, and it means a control-plane outage cannot block a
claim.

Two contact points are planned and out of scope here:

- **Console embed.** Studio adds the control plane as an MCP connection; the
  console arrives through `_meta.ui.resourceUri` and authenticates with the
  per-request Studio JWT, exactly as the hosting console does. Read-only for
  non-`@deco.cx` callers.
- **Claims.** Studio's `AgentSandboxProvider` calls the control plane instead
  of the kube API (see [Later](#later)). That is the slice where Studio gains
  a hard dependency on it and loses its cluster credentials.

### Why no database yet

The cluster already holds the desired state: `SandboxTemplate` objects the
operator reconciles. A catalog table would duplicate them and need a
reconciler of its own to notice drift. In this slice the control plane is
therefore **stateless over CRs**: labels and annotations carry the two facts
a CR does not (`variant`, `base-tag`), and `LIST` is a label query.

The database arrives with the first thing that is not a CR: claim history,
per-org tenant-pool desired state, cross-cluster views, an audit trail. That
is the [Later](#later) list, and it is also the point at which the applier
seam pays for itself. Until then a table is state to keep consistent with the
cluster for no reader.

### infra_applications

```
sandbox-images/
  README.md
  android/
    Dockerfile        # ARG BASE_TAG; FROM ghcr.io/decocms/studio/studio-sandbox-go:${BASE_TAG}
    bin/qa-android
    smoke.sh          # the Flutter + Firebase emulator test from #7461 (needs a KVM runner)
```

CI (`.github/workflows/sandbox-images.yaml`):

- Triggers: push touching `sandbox-images/**`; `repository_dispatch`
  `sandbox-base-released` with `{ "version": "<base tag>" }`;
  `workflow_dispatch` with a base tag.
- Matrix over variant directories. Each builds
  `ghcr.io/decocms/studio-sandbox-<variant>:<base tag>` for amd64+arm64,
  runs `smoke.sh` against the digest, signs, attests.
- On success calls `POST /api/v1/images/<variant>/tag` on **each** sandbox
  control plane with that env's service token — stg first, prod behind a
  manual approval environment. This replaces the deco-apps-cd values bump
  for variants entirely.

The studio release workflow adds one dispatch target: after the base is
pushed, fire `sandbox-base-released` to infra_applications alongside the
existing deco-apps-cd bump. Absent token → no-op, same as today.

## Version skew

Base and variant are published by two different CI runs, minutes apart.
During that window a variant pod runs a daemon one base version behind. This
is the same skew a rolling Studio deploy already tolerates: Studio ↔ daemon is
HTTP and both sides are already required to be one-version compatible. If a
base release ever breaks that, the fix is in the daemon contract, not in
coupling the two builds.

Failure mode to watch: the variant build fails and the base moves on. The
variant's `base-tag` annotation then trails the default template's image tag
indefinitely and nobody is paged. The console shows both in one row; alert
on the gap later if it bites.

## Flutter version

The base already pins `FLUTTER_VERSION=3.41.2` and documents that the pin
drifts. The variant inherits the problem. Two options, pick one:

1. **Human loop.** Customer bumps, we bump `sandbox-images/android/Dockerfile`.
   Adequate for one customer.
2. **Repo-driven (recommended once a second Flutter customer exists).**
   Install `fvm` in the variant. The skill runs `fvm use` from the repo's
   `.fvmrc` or pubspec `environment.flutter` at run start; the image
   pre-caches the version the current customers pin so the common case
   downloads nothing. This is what makes "compatible with their Dockerfile"
   true without anyone watching.

## Adding a variant, after this spec

1. PR to infra_applications: `sandbox-images/<name>/Dockerfile` (+ `smoke.sh`).
   CI publishes `studio-sandbox-<name>:<base tag>`.
2. `SANDBOX_IMAGE_UPSERT` on the stg control plane, then prod. The templates
   exist as soon as the call returns.
3. Optionally a detection row in Studio's `REPOSITORY_LINK` table.
4. The repository's owner picks it in Settings → Repositories, or step 3
   picked it for them.

No Studio deploy, no Helm PR.

## Rollout of this spec

**Sequencing decision.** The customer is blocked on an image and a template,
not on who owns the template. `#7461` ships first with one change: the
`z.enum` becomes a validated string, because that is the only part of the PR
the control plane design would have to undo at a contract level. The
`image-android/` directory, the variant CI job and the chart's
`imageVariants` block are landed as they are and removed later; each is a
`git mv` or a deletion, about a day in total, which is less than the wait
costs. The control plane is then built with nothing waiting on it, and the
Android variant becomes its first migration rather than its first feature —
a better first test, since the expected end state already exists in the
cluster.

Estimated effort, one person: Studio reshaping 1 day; infra_applications CI
1 day; control plane 1–2 weeks (repo, RBAC, Deployment, ArgoCD app, auth,
tools, REST mirror, console, review).


1. `#7461` lands with the enum replaced by a string. Chart before Studio,
   image published before the chart references its tag.
2. Studio follow-up: cluster-listed picker, detection on link, delete
   `image-android/`, the variant CI job and the chart's `imageVariants` —
   each once its replacement below is live.
3. infra_applications: `sandbox-images/android/` + workflow. Publish once by
   `workflow_dispatch` against the current base tag.
4. `decocms/sandbox-control-plane`: scaffold from the hosting control-plane,
   render + applier, the four tools, REST mirror, service tokens, console
   table. RBAC + Deployment manifests in its own chart; ArgoCD app in
   deco-apps-cd for stg.
5. `SANDBOX_IMAGE_UPSERT android` on stg; pin one repo; verify it lands on a
   KVM node and that `qa-android` drives the app under the pod's constraints.
   Then prod.
6. studio release workflow: add the `sandbox-base-released` dispatch.
7. After one release of real runs on the variant: remove Flutter from the
   base image.

## Later

- **Default template and pools through the control plane too.** Once
  variants go through it, the chart's own `SandboxTemplate` and
  `SandboxWarmPool` objects are the odd ones out. Moving them makes the chart
  operator + RBAC + gateway only, and "prewarm 4 default pods on prod" a
  tool call rather than a values PR.
- **Claims.** Studio's `AgentSandboxProvider` talks to the kube API directly
  today (claims, template probes, lifecycle watch, tenant pools). Moving that
  behind the sandbox control plane is what takes cluster credentials out of
  Studio and is the first feature that needs a database (claim history,
  tenant-pool desired state). It is also the slice where "global" becomes a
  process rather than a console, and where the applier seam gets its second
  implementation. Not in scope here; this spec only avoids blocking it.
- **`FROM <customer image>` + our layer.** Feasible because the daemon is one
  static Go binary, blocked by the width of the base runtime contract (bun,
  node, chromium, python office tooling, skills, typegen, harness-runner).
  Shrinking that contract is the prerequisite; this spec does not attempt it.
