# Sandbox claim identity + fleet cost — findings and spec

Written 2026-08-04 from a live read of `eks-serverless` / `agent-sandbox-system`
(prod) plus the `deco-apps-cd` and `terraform-eks-cluster` configs. Everything
in "Evidence" is observed, not inferred; everything in "Spec" is a proposal.

## Evidence

Fleet at the time of reading: **29 SandboxClaims, 34 Sandboxes, 44 pods, 30
sandbox pods across 16 nodes (1.875 pods/node)**.

The population is not a leak — it is arithmetic. ~58 distinct claims/hour ×
15-min TTL ≈ 30-35 steady state. Claims expire and reap correctly (112
`ClaimExpired` + 21 `SandboxReaped` in one hour) and TTL *is* renewed on
activity (claims at generation 3-4 have `shutdownTime` pushed past
creation + 15m). Sampled pods do real work: one logged a complete claude-code
turn, 53 dispatch frames, `code_change_published`, `result/success`.

Three real problems, in descending cost order:

1. **One tenant is 52% of the fleet.** Connection `conn_oDOpmssQvcGiQtxWVUc8i`
   (org `kAR0qp1G…`, repo `deco-sites/demo-storefront`) held **15 of 29 live
   claims**, minting a new thread every ~30s and accelerating. Every claim is
   correctly keyed (one thread → one sandbox, by design) and every pod is doing
   real dispatch work (58-165 frames each). These claims carry **no
   `user-email`/`user-name` annotation**, unlike every human claim — a
   non-interactive principal. There is no per-org or per-connection concurrency
   cap anywhere in the path.

2. **Duplicate claims for one logical sandbox.** ~14% of live claims. Two
   confirmed cases:

   ```
   hash 5ebbd7b76476aa24  — same user, same projectRef, TWO claims + TWO pods
     conn-rot3ncf1rdqj9tj557o-…   branch  thread:4719cbc0…/conn_RoT3ncf1RDQj9TJ557oC5
     thread-4719cbc0-cebb-44a-…   branch  sandbox/thread-4719cbc0…-conn_RoT3ncf1RDQj9TJ557oC5
   ```

   ```
   17:00:22.509  SandboxAdopted  s-67468eb31139dbc4          ← 0 dispatches, pure waste
   17:00:22.883  SandboxAdopted  ephemeral-67468eb31139dbc4  ← same hash, 0.4s later
   17:11:02      SandboxReaped   s-67468eb31139dbc4          ← reaped at 15m, never used
   ```
   Fired twice in the observed hour (again at 17:40:20).

3. **Packing is 1.875 pods/node against a nodepool designed for 5-6.** The
   NodePool comment (`eks-setup/karpenter-node-pools.tf:530-536`) reasons from
   *1Gi* pod requests; prod has requested **2Gi** since
   `apps/studio-sandbox-prod/values.yaml` set it (with a good justification —
   measured p95). The `instance-memory Gt 8191` floor was never raised to match,
   so Karpenter mints 8GiB/2vCPU nodes that hold 2 pods.

### Root cause of (2)

`computeHandle` takes `branch` as an argument **separate from** `id.projectRef`
— but `projectRef` already contains the branch:

```ts
// packages/sandbox/server/provider/sandbox-ref.ts:29
return `agent:${input.orgId}:${input.virtualMcpId}:${input.branch}`;

// packages/sandbox/server/provider/shared/handle.ts:29-33
export function computeHandle(id: SandboxId, branch?: string | null): string {
  const hash = hashSandboxId(id);        // ← from id.projectRef (contains branch)
  const slug = slugifyBranch(branch);    // ← from the separate argument
  return slug ? `${slug}-${hash}` : `s-${hash}`;
}
```

The two inputs are redundant but independent, so they can disagree. The claim
name **is** the dedupe key (`runner.ts:1159` — `name: handle`), and the whole
create/adopt ladder (`runner.ts:967-1069`) keys on exact name. Disagreement =
second claim = second pod on the same git branch.

Three ways they disagree today:

- **`runner.ts:506-508`** — `opts.branch ?? opts.repo?.branch ?? null`. Callers
  that omit `opts.branch` fall through to `repo.branch`, which is the *derived
  git ref* from `syntheticBranchToGitRef` (`thread-repo.ts:60`), producing the
  `thread-<id>-…` variant. `SANDBOX_START` passes `branch` explicitly and there
  is already a comment at `apps/api/src/tools/sandbox/start.ts:573` warning
  about exactly this hazard — the other `ensureSandbox` callers
  (`sandbox-dispatch-client.ts:261`, `load-repo.ts:217`,
  `cluster-sandbox-fs.ts:113`) are the exposure.
- **The `s-<hash>` fallback** — branch omitted entirely.
- **`resurrectByHandle` (`runner.ts:1928-1948`)** — replays persisted
  `ensureOpts`. If `branch` isn't in them, `ensure()` computes a *different*
  handle than the one it was asked to resurrect, then
  `this.records.get(handle)` misses and it returns `null`. The caller 404s
  **and** an orphan pod was just created. This matches the `s-`/`ephemeral-`
  pair exactly: 0.4s apart, same hash, the `s-` one never dispatched to.

A fourth, separate duplication that is **arguably correct but worth a decision**:
the hash includes `userId`, so two people on the same branch get two sandboxes.
Observed live: `deco-sites/montecarlo` + branch `stephanie-moraes-vb8ywesm` had
two claims, one keyed to Stephanie and one to Pedro Mendonça. Two pods with two
working trees pushing the same git branch is a lost-work hazard, not just spend.
`resolveSandboxUserId` (`thread-repo.ts:102-111`) already exists to collapse
this for `thread:*` branches — it does not cover user-branch shapes.

---

# Part 1 — Correctness fixes

## Fix 1 (root cause): make the handle derivable from `id` alone

Delete the `branch` parameter. Derive the slug from the ref that already
carries it.

```ts
// packages/sandbox/server/provider/sandbox-ref.ts — add next to composeSandboxRef
/** Slug source for a ref: the branch for agent refs, the threadId otherwise. */
export function refSlugSource(projectRef: string): string {
  if (projectRef.startsWith("thread:")) return projectRef.slice(7);
  // agent:<orgId>:<vmcpId>:<branch> — branch may itself contain ":"
  const parts = projectRef.split(":");
  return parts.length >= 4 ? parts.slice(3).join(":") : "";
}

// packages/sandbox/server/provider/shared/handle.ts
export function computeHandle(id: SandboxId): string {
  const hash = hashSandboxId(id);
  const slug = slugifyBranch(refSlugSource(id.projectRef));
  return slug ? `${slug}-${hash}` : `s-${hash}`;
}
```

Now slug and hash come from one value; disagreement is unrepresentable. This
also kills the `s-<hash>` fallback for every real caller — every live ref has a
slug source — so leave the fallback in place as a defensive branch but expect it
never to fire.

Callers to update: `runner.ts:506` (drop the `??` ladder entirely),
`claim-handle.ts:15` (drop the `branch` param, keep the function as the
documented single import point), `sandbox-proxy.ts:177`, and the desktop runner's
matching `hashLen=16` site.

**This changes existing handles** for any claim whose slug was previously
computed from a disagreeing branch. Those are exactly the broken ones, and TTL
is 15 min, so ship it and let the fleet roll over. No migration.

`bun test` note: `handle.test.ts` asserts the two-arg signature — invert those
cases rather than appending (per CLAUDE.md's testing rule).

## Fix 2: `ensure()` must not guess

With Fix 1 the `opts.branch ?? opts.repo?.branch ?? null` ladder is gone. Add a
cheap invariant so a malformed ref fails loudly instead of silently minting an
`s-<hash>` orphan:

```ts
// runner.ts, in ensure()
const handle = composeBranchHandle(id);
// ponytail: assert, don't recover — an unsluggable ref is a caller bug, and
// the silent `s-<hash>` fallback cost us duplicate pods in prod (2026-08-04).
if (handle.startsWith("s-")) {
  throw new Error(`ensure: projectRef has no slug source: ${id.projectRef}`);
}
```

Keep `opts.repo.branch` — it is still the git ref the daemon checks out. It just
stops feeding identity.

## Fix 3: `resurrectByHandle` must assert it resurrected *that* handle

```ts
// runner.ts:1946 — replace `await this.ensure(row.id, opts)`
const resurrected = composeBranchHandle(row.id);
if (resurrected !== handle) {
  // The state-store row and the handle disagree — resurrecting would create a
  // second claim under a different name. Fail to 404 instead; the UI's
  // notFound → SANDBOX_START flow re-supplies correct opts.
  this.logger?.warn("resurrect handle mismatch", { handle, resurrected });
  return null;
}
await this.ensure(row.id, opts);
return this.records.get(handle) ?? null;
```

After Fix 1 this should be unreachable (both sides derive from `row.id`), which
is the point — it is the assertion that keeps it unreachable.

## Fix 4: keep `Date.now()` out of the identity path

`generateBranchName()` (`packages/shared/src/branch-name.ts:62`) is
`Date.now()` base36-reversed — every call mints a new branch and therefore a new
sandbox. That is the intended semantic for "new chat", and the header comment
says so. The bug is the paths that mint one *by accident*:

- `apps/api/src/tools/sandbox/start.ts:129-130` — `SANDBOX_START` with no
  `branch` mints one server-side.
- `apps/web/src/components/sandbox/hooks/sandbox-lifecycle-context.tsx` —
  `shouldAutoStart` was already fixed to require `branch` after a documented
  prod leak ("sibling branches minted 8ms apart … one leaked pod per new chat",
  lines 45-56). **`shouldSelfHeal` (113-122) and `shouldAutoRetryClaim`
  (215-225) still do not require it**, and `buildSandboxStartArgs` (164-173)
  omits `branch` when null. A self-heal on a crashed sandbox therefore orphans
  the old claim and provisions a fresh one.

Fix: require a non-null `branch` in `shouldSelfHeal` and
`shouldAutoRetryClaim`, same one-line guard as `shouldAutoStart`. Then make
`SANDBOX_START` reject a missing `branch` outright rather than minting — branch
selection belongs to the caller that owns the thread. Sweep the 5 mint sites
listed in the trace and confirm each is a deliberate "new identity" action
(thread create, explicit "new branch" menu, post-squash-merge switch).

## Fix 5 (decision needed): same branch, two users

Not a bug until you decide the policy. Two options:

- **Collapse** — extend `resolveSandboxUserId` to user-branch shapes so a branch
  resolves to its owner's sandbox for every org member. Removes the duplicate
  pod and the double-push hazard. Cost: teammates share one working tree, so
  concurrent edits collide inside the sandbox instead of in git. This is the
  shared-sandbox problem that `#5112`/`#5116`/`#5132` attempted and `#5240`
  fully reverted — do not re-attempt casually.
- **Keep per-user, block the push** — leave two sandboxes, but make the second
  one's git ref distinct (it is a different user's work) so they cannot both
  push the same branch. Smaller, safer, no shared-state design needed.

Recommendation: **the second**. It is a one-line change to the derived ref and it
removes the data-loss hazard without reopening collaboration.

## Fix 6: a test per fix, in the right tier

- Unit (`handle.test.ts`): invert the two-arg cases; add "slug and hash derive
  from the same ref" and "`thread:` ref slugs from threadId".
- Unit: `refSlugSource` on an `agent:` ref whose branch contains `:` and `/`.
- E2E (`packages/e2e`): drive two `ensureSandbox` callers for one thread — one
  passing the synthetic branch, one passing the derived git ref — and assert
  **one** claim exists. This is the regression that would have caught the
  `5ebbd7b76476aa24` pair.
- E2E: resurrect-by-handle with `ensureOpts` missing `branch` → 404, and assert
  **no** new claim was created.

---

# Part 2 — Guardrails

These are what turn "we found it after the fact with kubectl" into "we get
paged".

1. **Per-org concurrent sandbox cap.** The 15-claims-from-one-connection case
   has no ceiling today. Cheapest correct version: count live claims by
   `studio.decocms.com/org-id` label before provisioning and reject over the cap
   with a typed error the UI can render. Default it generously (say 20) and put
   it behind an org flag in `OrgFlagsSchema` so a real customer can be raised
   without a deploy. *ponytail: a label count on an indexed informer, not a new
   table.*

2. **A duplicate-hash metric.** The invariant is one-line checkable and would
   have caught both bugs on day one:
   ```
   count(count by (hash) (agent_sandbox_claim_live) > 1)
   ```
   Emit `hash` (the 16-hex suffix) as a label from the claim informer the runner
   already watches (`runner.ts:490`). Alert on `> 0` — it should be
   structurally impossible after Fix 1, which makes it a perfect regression
   canary.

3. **A zero-dispatch-at-reap counter.** Every wasted pod in this investigation
   was identifiable by "reaped at TTL with zero dispatch frames". Increment a
   counter on that condition in the housekeeper sweep. It is the direct
   $-waste signal.

4. **Annotate the principal.** Claims from non-interactive principals had no
   `user-email` annotation, which is how I spotted the hot tenant — but that was
   luck. Stamp an explicit `studio.decocms.com/principal-kind`
   (`user` | `automation` | `anonymous`) so bot traffic is filterable by label
   rather than by absence.

---

# Part 3 — Cost

Ranked by expected saving. The first two dwarf the rest.

## C1. Cap the runaway tenant — up to ~50% of the fleet

15 of 29 claims from one connection. Every one is doing real work, so this is a
product/limits decision, not a bug fix: either that workload is legitimate (and
wants its own pool and budget) or it is a loadtest/demo generator that should be
rate-limited. **This is the single largest line item and it needs a human
decision before any infra tuning is worth doing.** Guardrail 1 is the mechanism.

I could not determine which it is — that needs the `threads` table, and the
`kubectl exec` into the prod API pod was blocked by the permission classifier in
this session.

## C2. Verify (and force) spot — up to ~65% off instance hours

`karpenter-node-pools.tf:503-505` allows `["on-demand", "spot"]`, and
`terminationGracePeriodSeconds: 90` is already sized to fit AWS's 120s spot
reclaim notice with a 30s-bounded git push
(`deploy/helm/sandbox-env/values.yaml:79`). So the workload is *already*
spot-safe by design. What I could not check is the current mix — node listing is
denied to my read-only role.

If sandbox nodes are materially on-demand today, this is the biggest infra lever
available and the work is a `requirements` change plus a
`karpenter.sh/capacity-type: spot`-weighted preference. Check first:

```
kubectl -n agent-sandbox-system get pods -l app.kubernetes.io/name=studio-sandbox-prod \
  -o custom-columns=NODE:.spec.nodeName --no-headers | sort -u \
  | xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.karpenter\.sh/capacity-type}{"\n"}' \
  | sort | uniq -c
```

## C3. `consolidateAfter: 10m` → `2m` — ~25-30% of node-hours, nearly free

`karpenter-node-pools.tf:551-556` already documents that underutilized
consolidation **never runs** for this pool (Karpenter cannot reschedule
Sandbox-CRD-owned pods), so nodes shrink *only* via empty-delete, and
`consolidateAfter` is the entire latency of that. With 15-min claims and ~1.9
pods/node, a node's useful life is roughly 15-25 min — a 10-minute idle tail is
30-40% of its billed life, paid on every one of the ~58 claims/hour worth of
node churn.

Drop it to 2-3m. The node is empty by definition, so there is no eviction risk.
**Ceiling: more node churn means more cold-start latency on the next burst** —
pair it with C5 if p95 provision time regresses.

## C4. Fix the packing floor — 1.875 → ~6 pods/node

The NodePool's memory floor reasons from a 1Gi pod request that is now 2Gi:

```
# karpenter-node-pools.tf:530-536 (comment)  "each studio-sandbox pod requests 1Gi"
# karpenter-node-pools.tf:537-541            instance-memory Gt 8191 / Lt 32769
# apps/studio-sandbox-prod/values.yaml       requests: cpu 500m, memory 2Gi
```

An 8GiB/2vCPU node has ~7Gi allocatable; minus the ~8-pod kube-system daemonset
it holds **2** pods at 2Gi + 128Mi sidecar. CPU is also near-binding there
(550m × 3 = 1.65 of ~1.67 free vCPU) — the comment's "CPU is nowhere near
binding" is stale for the same reason.

Change: raise the floor to `Gt 16383` (≥16GiB, i.e. m6a.xlarge class and up).
~14Gi free → 6 pods, ~3.6 free vCPU → 6 pods.

**Do not do this without also raising the disk.** At 6 pods the `8Gi`
ephemeral-storage *request* needs 48Gi, against ~50Gi allocatable on the current
60Gi `/dev/xvdb` (`karpenter-node-class.tf:118-122`). Ephemeral storage becomes
the new binding constraint the moment memory stops being one. Raise `xvdb` to
100Gi, or measure actual p95 sandbox disk use and lower the request — the
request is a scheduling reservation, and 8Gi may be far above real usage.

Second-order win: the `podAffinity` soft co-location
(`apps/studio-sandbox-prod/values.yaml`) exists to warm the node-local
`depsCache` hostPath. Packing 6 repos per node instead of 2 raises that
cache-hit rate directly, which cuts boot cost.

Honest sizing: this is ~25-30%, not 3×. You still pay for the same total memory;
what you stop paying is the *per-node fixed overhead* — daemonset CPU/memory and
64Gi of gp3 per node — 16 times over instead of 6. EBS alone: 16 × 64Gi ≈ 1TiB
≈ $82/mo → 6 × 104Gi ≈ 624Gi ≈ $50/mo.

## C5. Consider `nodePlaceholder` if C3/C4 hurt latency

Disabled in prod today (`deploy/helm/sandbox-env/values.yaml:438-439`, not
overridden). It is the designed answer to "shorter `consolidateAfter` means more
cold node provisions": 1-2 low-priority placeholder pods hold warm capacity that
a real claim preempts. Only turn it on if you measure a p95 provision-time
regression after C3 — otherwise it is capacity you pay for to save latency you
weren't losing.

## C6. Chart drift — verify before trusting any of the above

`deco-apps-cd/values.yaml:120` pins prod to sandbox-env **0.10.0**; the chart in
this repo is at **0.10.8**. Anything in `deploy/helm/sandbox-env/` newer than
0.10.0 is not running in prod. (The local values also differ from what prod
actually has: `ephemeral-storage` limit 10Gi local vs 8Gi live.) Confirm which
version is live before concluding a knob is set the way the repo says.

I did verify the resource block *is* applied — the live `SandboxTemplate` and
pods both show requests `500m`/`2Gi`, limits `2`/`4Gi`/`8Gi`.

## Not a problem — checked and fine

- **TTL / reaping.** 15-min claim TTL + the housekeeper at `idleTtlSeconds: 600`
  on a `* * * * *` schedule. Idle sandboxes die in ~10 min. Working as designed.
- **Warm pool sizing.** `minReplicaCount: 1`, `max: 6`, KEDA on claim-creation
  rate, with the reasoning documented from 30 days of real data in
  `apps/studio-sandbox-prod-keda/values.yaml`. No change warranted.
- **Controller health.** The `Failed to update … status` / `Reconciler error`
  spam in the controller log is benign optimistic-concurrency conflict
  (`the object has been modified`), retried successfully. Not worth chasing.

---

## Suggested order

1. Guardrail 2 (duplicate-hash metric) — ship first, it measures Fix 1.
2. Fixes 1-3 + tests. One PR, small diff, no migration.
3. C3 (`consolidateAfter`) — one-line terraform, immediate saving.
4. Decide C1 (the hot tenant). Needs the DB and a product call.
5. C2 (verify spot), then C4 (memory floor **plus** disk) as one change.
6. Fixes 4-5 and the remaining guardrails.
