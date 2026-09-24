# Sandbox variants in the control plane

Status: proposal, 2026-09-24, checked against `decocms/control-plane@295bde8`
and `decocms/operator@34d0005`. A feature of the existing hosting control
plane (closed source). There is no separate `decocms/sandbox-control-plane`.
Companion to `sandbox-controller-spec.md`, which owns the `SandboxVariant`
resource and the `@decocms/sandbox-controller-types` package this feature
builds on.

## What it is

The same loop hosting already runs, with one new kind:

| hosting today | this feature |
|---|---|
| desired state in `controlplane.*` tables | `controlplane.sandbox_variants` |
| pure render → `deco.sites` CR (`server/core/render/*`) | pure render → `sandbox.deco.cx/v1alpha1 SandboxVariant` |
| `AgentApplier` writes `desired_resources` for a cluster | same applier, same table |
| data-plane agent (`decocms/operator cmd/agent`) pulls, SSA-applies, prunes | a second agent install on the sandbox cluster, managed group `sandbox.deco.cx` |
| `decocms/operator` reconciles the CR | the OSS sandbox controller reconciles it |
| agent inventory → `observed_resources` (spec + status) | same, so the console shows `Ready` / `ImageAvailable` |

The feature writes one small object per variant per environment. It does not
render templates, check registries, or know what a claim is: the controller
does all of that and reports through the object's `status`.

It is **off the claim path**:

- It never talks to Studio or the controller. Its only output is
  `desired_resources` rows.
- If it goes down, the agent keeps the last applied state: an unreachable
  control plane means an incomplete fetch, and the agent's prune guard then
  deletes nothing. Claims keep working.
- A self-hosted cluster has no agent and no control plane; the chart's
  `imageVariants` writes the same objects.

## Why it is needed

Some repositories need a toolchain the default image does not carry. The
first case is a customer's Flutter mobile app: its dependencies do not
compile to JS and it calls native-only plugins at startup, so the only way to
QA it unmodified is an Android emulator (~6GB of SDK and image, plus
`/dev/kvm`).

The chart can declare a variant, but on deco's clusters every add or retag
would be a values PR per environment. Variants track customers' toolchains,
so they change more often than the platform does, and they need their own
nodes.

## Ownership

| owner | owns | changes when |
|---|---|---|
| `decocms/studio` (OSS) | controller, `SandboxVariant` CRD + reconciler, `@decocms/sandbox-controller-types`, base image, chart | never, for a new variant |
| `decocms/control-plane` | `sandbox_variants` table, render, tools, console tab | a variant is added, retagged, prewarmed |
| `decocms/operator` | the data-plane agent binary and `chart-agent` | no change needed |
| `decocms/infra_applications` | the sandbox cluster's agent install; `sandbox-images/<variant>/` + CI | a variant's toolchain changes |

## Design

**State.** `controlplane.sandbox_variants`, one row per
`(cluster, baseTemplate, variant)`: the `SandboxVariant` spec fields (`image`,
`baseTag`, scheduling, `resources`, `volumeSizes`, `warmPool`), `enabled`, and
`updatedBy` / `updatedAt`. Same shape of decision as the existing
`platform_images` catalog: a control-plane-owned table that renders into
what the cluster runs.

The base template is part of the key because stg and prod sandboxes share
one cluster and one template namespace (`agent-sandbox-system`) and differ
only by base (`studio-sandbox-staging` vs `studio-sandbox-prod`). The
rendered object is named `<baseTemplate>-<variant>`. "Staging first, then
prod" is two bases on one agent, not two clusters.

**Render.** `renderSandboxVariant(row) → { apiVersion, kind, metadata, spec }`
in `server/core/render/sandbox-variant.ts`: pure, no I/O, typed against
`@decocms/sandbox-controller-types`. A disabled or deleted row becomes a
`desired_resources` tombstone. The agent prunes the object, and the
controller garbage-collects the four objects it rendered from it.

**Apply.** Through the existing `AgentApplier`: a `desired_resources` row per
object, cluster set to the sandbox cluster's name. Nothing new in the
applier.

**The agent on the sandbox cluster.** A new install under
`decocms/infra_applications/provisioning/data-plane-agent/<sandbox-cluster>/`,
next to `hub` and `main`, with:

- `group: sandbox.deco.cx`. The ClusterRole is templated from `group`, so
  the agent can act on that group and nothing else. Out-of-group items are
  refused in code (`internal/agent/reconciler.go`).
- `apply-namespaces` limited to `agent-sandbox-system`.
- `secrets.enabled: false`. No secret materialization is needed.
- A per-cluster token in AWS Secrets Manager via ExternalSecret, the same as
  `hub`. The cluster identity comes from the token.
- Rollout starts `dryRun: true`, as `hub` is today.

The CRD must exist before the agent applies anything. Since operator#100,
the agent skips items whose CRD is missing instead of freezing the fleet, so
ordering mistakes degrade to "not applied yet".

**Ownership.** The agent stamps `managed-by=deco-data-plane-agent` on
everything it applies, and its prune sweeps only that label, so it can never
delete the chart's objects. The one collision left is a same-named object
the chart already manages. `SANDBOX_VARIANT_UPSERT` refuses when
`observed_resources` shows the name with `managed-by=Helm`, and names the
handover step; `SANDBOX_VARIANT_ADOPT` is the one path over such an object.

**Status.** Read from `observed_resources` (the agent's inventory, spec and
status per object). Nothing new is needed for the console to show the
controller's conditions.

**Tools** (MCP, plus the `/api/v1` REST mirror CI calls, super-admin only):

- `SANDBOX_VARIANT_LIST { cluster?, baseTemplate? }` — rows plus observed
  `status` (`Ready`, `ImageAvailable`, `baseTag` vs `defaultTemplateTag`).
- `SANDBOX_VARIANT_UPSERT { cluster, baseTemplate, variant, image, baseTag,
  nodeSelector?, tolerations?, resources?, volumeSizes?, warmPool? }`.
- `SANDBOX_VARIANT_TAG_SET { name, tag, baseTag, targets: [{cluster, baseTemplate}] }`
  — what CI calls.
- `SANDBOX_VARIANT_ADOPT { cluster, baseTemplate, variant }` — take over a
  Helm-managed `SandboxVariant`. Allowed only when the observed object
  carries `helm.sh/resource-policy: keep` and its spec equals what the new
  row renders. The agent's apply then replaces the `managed-by` label and
  changes nothing else.
- `SANDBOX_VARIANT_DELETE { cluster, baseTemplate, variant }` — tombstones the row.
  Repositories pinned to that variant then fall back to the default image,
  which is the designed behaviour.

**Auth.** The control plane's existing model: the super-admin identity
(admin token, or a Studio JWT with an `@deco.cx` email) for tools and the
console, and a REST service token per environment for infra_applications' CI.
Nothing here is scoped to a tenant.

**Console.** One tab: variant, cluster/base, `repository:tag`, base tag
next to the default template's tag (skew at a glance), pool sizes, `Ready`,
last change.

## infra_applications

```
sandbox-images/
  README.md
  android/
    Dockerfile        # ARG BASE_TAG; FROM ghcr.io/decocms/studio/studio-sandbox-go:${BASE_TAG}
    bin/qa-android
    smoke.sh          # Flutter + Firebase emulator test from #7461 (needs a KVM runner)
```

`.github/workflows/sandbox-images.yaml`:

- Triggers: push touching `sandbox-images/**`; `repository_dispatch`
  `sandbox-base-released { version }` from the studio release workflow;
  `workflow_dispatch` with a base tag.
- Matrix over variant directories. Each builds
  `ghcr.io/decocms/studio-sandbox-<variant>:<base tag>` for amd64 + arm64,
  runs `smoke.sh` against the digest, signs and attests.
- On success, `TAG_SET` for the staging base, then prod behind a
  manual-approval environment. This replaces the deco-apps-cd values bump for
  variants.

## Version skew

Base and variant are published by two CI runs, minutes apart, so a variant
pod can run a daemon one base version behind. A rolling Studio deploy already
tolerates that skew. If a base release ever breaks it, the fix belongs in the
daemon contract.

The failure to watch: the variant build fails and the base moves on.
`baseTag` then trails `status.defaultTemplateTag` indefinitely. The console
shows both in one row. Alert on the gap if it bites.

## Flutter version

The Android image pins `FLUTTER_VERSION`, and the pin drifts. Pick one:

1. **Human loop.** The customer bumps, we bump the Dockerfile. Adequate for
   one customer.
2. **Repo-driven** (once a second Flutter customer exists). `fvm` in the
   image; the skill runs `fvm use` from the repo's `.fvmrc` or pubspec
   `environment.flutter`; the image pre-caches the versions current customers
   pin.

## Adding a variant

1. PR to infra_applications: `sandbox-images/<name>/Dockerfile` (+
   `smoke.sh`). CI publishes the image.
2. `SANDBOX_VARIANT_UPSERT` for staging, then prod. The templates exist
   after one agent cycle (about 30s, or about 1s with the stream push) plus
   one controller reconcile. A hardware-bound variant needs its node pool
   first (Terraform, outside this feature).
3. Optionally, a detection row in Studio's `REPOSITORY_LINK` (an OSS PR, and
   the only Studio change).
4. The repository owner picks it in Settings → Repositories, or step 3 did.

No Studio deploy, no Helm PR.

## Rollout

After OSS Phase 1 (controller reconciling variants, the types package
published, the chart emitting `SandboxVariant`):

1. **infra_applications**: `sandbox-images/android/` + workflow. Publish once
   by `workflow_dispatch` against the current base tag, and compare the
   result against what `image-android/` produces.
2. **infra_applications**: the agent install for the sandbox cluster,
   `dryRun: true`. Check the agent's status reports `complete=true` and
   zero applies.
3. **control-plane**: table, render, the five tools, REST mirror, CI token,
   console tab. Behind a global feature flag, off by default.
4. **Handover on staging**, one variant at a time:
   1. Set `imageVariants.android.keep: true` in staging's deco-apps-cd
      values. The chart adds `helm.sh/resource-policy: keep` to that
      `SandboxVariant`.
   2. `SANDBOX_VARIANT_ADOPT`. The agent applies the identical spec, so the
      object is now labelled as the agent's. Nothing is re-rendered.
   3. Set staging's `imageVariants: {}`. Helm leaves the kept object in
      place, so its `ownerReference`s still hold and the templates stay.
   4. Check that a pinned repository lands on a KVM node and that
      `qa-android` drives the app. Then `TAG_SET` to the infra_applications
      image.

   The `SandboxVariant` itself has to survive, not just the templates:
   rendered templates are owned by it, so deleting it garbage-collects
   them whatever annotations they carry.

   Then prod, the same way. Turn off the agent's `dryRun` before step 4.
5. **OSS**: remove `packages/sandbox/image-android/` and its release job.

Estimated effort, one person: infra_applications CI 1 day; agent install
under a day; this feature 2–3 days, since the applier, agent, inventory, API,
MCP and console already exist.

## Checked, and what's left to check

Checked in code:

- The control plane is TypeScript (Bun + `@decocms/runtime`), so it shares
  types with the Go controller through the generated package, not by import.
- The agent's managed group is a flag and its ClusterRole is templated from
  it, so a sandbox-cluster install scoped to `sandbox.deco.cx` needs no agent
  code change.
- Status reads back through `observed_resources`.
- Today the agent runs only on `hub` (dry-run) and `main`. Nothing runs on
  the sandbox cluster yet.

Still to check with the control-plane owners:

- Whether they're fine with a second managed group on a new cluster, and
  with sandbox rows in `desired_resources` next to hosting's.
- The sandbox cluster's name in the control plane's placement, and how a
  REST token authorizes a super-admin-only tool.

## Later

- **Tenant pools**, once the controller reconciles a `SandboxTenantPool`:
  per-org rows, the same render and apply.
- **Default template size and prewarming** on deco's clusters, as fields on
  a per-base row, so "prewarm 4 default pods on prod" is a tool call.
- **A closed controller runtime** (e.g. a microVM backend) would **not** live
  here: it is a closed controller binary importing the OSS controller as a
  library, because placement is on the claim path.
