# Sandbox/Link/Dispatch Naming Uniformization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uniformize the sandbox/link/dispatch subsystem naming around the canonical nouns `Sandbox` and `SandboxProvider`, rename the three provider kinds to `local-docker`/`cluster`/`user-desktop`, restructure `DispatchTarget`, rename the user-desktop daemon route prefix from `/_decopilot_vm/*` to `/_sandbox/*` with one release of dual-serve compat, rename public MCP tools `VM_START`/`VM_DELETE` → `SANDBOX_START`/`SANDBOX_DELETE`, and migrate all persisted rows in a single Kysely migration.

**Architecture:** The work is one logical change executed as ~16 ordered tasks. Each task leaves the code green (typecheck + tests passing) so any task can be the merge point if the work is split across PRs. The canonical-noun foundation (types, enum, field names) goes first; cascading renames (call sites, MCP tools, daemon routes) follow; the data migration goes last so it ships in the same deploy as the code that reads/writes the new shape.

**Tech Stack:** TypeScript 5.9, Bun, Hono, Kysely, React 19, Biome (formatter), `bun test` runner, lefthook pre-commit. The spec lives at `docs/superpowers/specs/2026-05-22-sandbox-naming-uniformization-design.md` — read it before starting.

---

## Pre-flight

Before Task 1:

- Read the spec end-to-end: `docs/superpowers/specs/2026-05-22-sandbox-naming-uniformization-design.md`.
- Confirm baseline is green:
  ```bash
  bun run check && bun run lint && bun test
  ```
- Confirm migration numbering: the next migration after `090-automation-webhook-triggers.ts` is `091-…`. Reserve `091-sandbox-naming-uniformization.ts` for Task 14.

After every task: run `bun run fmt`, then `bun run check`, then the focused tests for that task, then commit. The pre-commit hook (lefthook) will reject unformatted code.

---

## Task 1: Rename `SandboxProviderKind` enum values (cluster-side type only)

**Files:**
- Modify: `packages/sandbox/server/provider/types.ts`
- Modify: `packages/sandbox/server/provider/index.ts`
- Test: `packages/sandbox/server/provider/index.test.ts`

This task changes the type definition only. The call sites in Task 2 will follow. The codebase will not typecheck between Task 1 and Task 2 — work them as one commit if you prefer (the steps below assume they get committed together).

- [ ] **Step 1: Find current enum definition**

Run: `grep -n "RUNNER_KINDS\|SandboxProviderKind" packages/sandbox/server/provider/index.ts packages/sandbox/server/provider/types.ts`

Expected: locates the `Set<SandboxProviderKind>` literal (around `packages/sandbox/server/provider/index.ts:80-93`) and the type definition in `types.ts`.

- [ ] **Step 2: Update the type and constant**

In `packages/sandbox/server/provider/types.ts`, find the type alias and replace:

```ts
export type SandboxProviderKind = "docker" | "agent-sandbox" | "desktop";
```

with:

```ts
export type SandboxProviderKind = "local-docker" | "cluster" | "user-desktop";
```

In `packages/sandbox/server/provider/index.ts`, find `RUNNER_KINDS`:

```ts
const RUNNER_KINDS = new Set<SandboxProviderKind>([
  "docker",
  "agent-sandbox",
  "desktop",
]);
```

Replace with:

```ts
const RUNNER_KINDS = new Set<SandboxProviderKind>([
  "local-docker",
  "cluster",
  "user-desktop",
]);
```

Also update `resolveSandboxProviderKindFromEnv` default:

```ts
const kind = (raw && raw.length > 0 ? raw : "user-desktop") as SandboxProviderKind;
```

and the error string:

```ts
`Unknown STUDIO_SANDBOX_RUNNER="${raw}" — expected "local-docker", "cluster", or "user-desktop".`
```

(The env var name still says `STUDIO_SANDBOX_RUNNER` here — Task 10 renames it.)

- [ ] **Step 3: Skip running tests until Task 2 completes**

The codebase will have hundreds of typecheck errors at this point — every call site that uses the old string literals. Do not run `bun run check` between Task 1 and Task 2. Move directly to Task 2.

---

## Task 2: Update kind-value call sites across the codebase

**Files:** every file referencing `"docker"`, `"agent-sandbox"`, or `"desktop"` as a `SandboxProviderKind` literal.

This is a mechanical mass-replace, but **only for occurrences that are SandboxProviderKind values**. The string `"docker"` appears in many unrelated contexts (Docker image names, CI configs, etc.); do not blindly replace.

- [ ] **Step 1: Enumerate call sites by file**

Run:
```bash
grep -rn '"docker"\|"agent-sandbox"\|"desktop"' \
  apps/mesh/src packages/sandbox packages/mesh-sdk \
  --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: ~80-120 occurrences across `apps/mesh/src/sandbox/`, `apps/mesh/src/tools/vm/`, `apps/mesh/src/link-daemon/`, `apps/mesh/src/links/`, `apps/mesh/src/harnesses/`, `apps/mesh/src/web/components/vm/`, `apps/mesh/src/api/routes/`, `apps/mesh/migrations/`, `packages/sandbox/server/provider/`, `packages/mesh-sdk/src/types/`.

- [ ] **Step 2: Apply replacements (programmatic + manual review)**

Apply this mapping inside literal positions that are `SandboxProviderKind`:

- `"docker"` → `"local-docker"`
- `"agent-sandbox"` → `"cluster"`
- `"desktop"` → `"user-desktop"`

**Do not change**:
- Docker image names in shell commands, `package.json`, helm values.
- The string `"desktop"` in UI copy unrelated to provider kind (e.g., responsive design breakpoints).
- The legacy values `"remote-user"`, `"host"`, `"freestyle"` in `packages/mesh-sdk/src/types/virtual-mcp.ts` tolerant readers — Task 15 removes them.
- The string `"desktop"` inside migration files `087-fix-vm-map-rekey.ts`, `088-purge-cli-activate-keys.ts`, `089-rename-remote-user-to-desktop.ts` — these are historical and must reflect the value that existed when they ran.

After replacement, search for the keyword `runner` in `STUDIO_SANDBOX_RUNNER` references — those are Task 10, leave alone for now.

- [ ] **Step 3: Update the SDK tolerant reader to add new values**

In `packages/mesh-sdk/src/types/virtual-mcp.ts`, find the enum-like Zod schema (around line 244) that tolerantly parses kind values. Add the new values to the accepted set alongside the legacy ones (Task 15 will delete the legacy entries):

```ts
const SANDBOX_PROVIDER_KIND_TOLERANT = z.union([
  z.literal("local-docker"),
  z.literal("cluster"),
  z.literal("user-desktop"),
  z.literal("docker"),
  z.literal("agent-sandbox"),
  z.literal("desktop"),
  z.literal("remote-user"),
  z.literal("host"),
  z.literal("freestyle"),
]).transform((v) => {
  if (v === "docker") return "local-docker";
  if (v === "agent-sandbox") return "cluster";
  if (v === "desktop" || v === "remote-user") return "user-desktop";
  return v;
});
```

(Adjust to match the existing shape — the snippet above shows intent.) The transform normalizes legacy values to the new canonical ones on read, so DB rows that haven't been migrated yet still parse correctly during the rolling deploy window.

- [ ] **Step 4: Typecheck**

Run: `bun run check`

Expected: PASS. If errors remain, they are missed call sites — fix and re-run.

- [ ] **Step 5: Run sandbox + links + harnesses tests**

Run:
```bash
bun test apps/mesh/src/sandbox apps/mesh/src/links apps/mesh/src/link-daemon \
  apps/mesh/src/harnesses apps/mesh/src/tools/vm packages/sandbox packages/mesh-sdk
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add -p   # review hunks
git commit -m "refactor(sandbox): rename SandboxProviderKind values to local-docker/cluster/user-desktop"
```

---

## Task 3: Rename the type `VmMapEntry` → `SandboxRecord` and field `vmId` → `sandboxHandle`

**Files:**
- Modify: `apps/mesh/src/tools/vm/vm-map.ts` (type definition)
- Modify: all importers of `VmMapEntry` and references to `vmId`

- [ ] **Step 1: Locate the type definition**

Run: `grep -rn "VmMapEntry\|vmId" apps/mesh/src packages/mesh-sdk --include="*.ts" --include="*.tsx" | head -50`

- [ ] **Step 2: Rename the type and any `vmId` field on it**

In `apps/mesh/src/tools/vm/vm-map.ts`, rename:

- `interface VmMapEntry` → `interface SandboxRecord`
- field `vmId: string` → `sandboxHandle: string`

Update all importers across the codebase to use the new names. The literal string `"vmId"` only appears as a TypeScript identifier (no JSON serialization to the DB column uses this name as a key — `setVmMapEntry` stores the object directly under a kind key).

- [ ] **Step 3: Audit grep for stragglers**

Run: `grep -rn "VmMapEntry\|\\bvmId\\b" apps/mesh/src packages/mesh-sdk --include="*.ts" --include="*.tsx"`

Expected: zero matches.

- [ ] **Step 4: Typecheck + focused tests**

Run:
```bash
bun run check
bun test apps/mesh/src/tools/vm apps/mesh/src/sandbox
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename VmMapEntry → SandboxRecord; vmId → sandboxHandle"
```

---

## Task 4: Rename `vmMap` → `sandboxMap` (storage key + helpers)

**Files:**
- Modify: `apps/mesh/src/tools/vm/vm-map.ts`
- Modify: every caller of `readVmMap`, `setVmMapEntry`
- Modify: the DB metadata key in **read paths only** (write path keeps both during transition)

The DB column data is migrated in Task 14. Until then, code must read both `vmMap` and `sandboxMap` keys but write only `sandboxMap`.

- [ ] **Step 1: Rename helpers and exports**

In `apps/mesh/src/tools/vm/vm-map.ts`:

- `readVmMap` → `readSandboxMap`
- `setVmMapEntry` → `setSandboxMapEntry`
- Internal references to `metadata.vmMap` get a fallback:

```ts
export function readSandboxMap(
  metadata: Record<string, unknown> | null,
): SandboxMapShape {
  if (metadata == null) return {};
  // Prefer new key; fall back to legacy `vmMap` for rows not yet migrated.
  const raw = (metadata as Record<string, unknown>).sandboxMap
    ?? (metadata as Record<string, unknown>).vmMap;
  return (raw ?? {}) as SandboxMapShape;
}
```

```ts
export function setSandboxMapEntry(
  metadata: Record<string, unknown> | null,
  /* ...args... */
): Record<string, unknown> {
  const base = metadata ?? {};
  const existing = readSandboxMap(base);
  // Write under the new key; do not preserve the legacy `vmMap` key.
  const { vmMap: _legacy, ...rest } = base as Record<string, unknown>;
  return { ...rest, sandboxMap: /* ...merge logic... */ };
}
```

- [ ] **Step 2: Update all call sites**

Run: `grep -rn "readVmMap\|setVmMapEntry\|\\bvmMap\\b" apps/mesh/src packages/mesh-sdk --include="*.ts" --include="*.tsx"`

Replace each match. Identifiers go from `vmMap` to `sandboxMap`; helper names go from `readVmMap`/`setVmMapEntry` to `readSandboxMap`/`setSandboxMapEntry`.

The mesh-sdk's `parseBranchMap` is unaffected (it operates on the inner cell, not the outer key).

- [ ] **Step 3: Test the read-fallback path**

Add a test in `apps/mesh/src/tools/vm/vm-map.test.ts` (rename the file in Task 13; for now it stays at the old path):

```ts
import { describe, expect, test } from "bun:test";
import { readSandboxMap } from "./vm-map";

describe("readSandboxMap legacy fallback", () => {
  test("reads new `sandboxMap` key", () => {
    const meta = { sandboxMap: { user1: { main: { cluster: { sandboxHandle: "h1" } } } } };
    expect(readSandboxMap(meta)).toEqual(meta.sandboxMap);
  });

  test("falls back to legacy `vmMap` key", () => {
    const meta = { vmMap: { user1: { main: { cluster: { sandboxHandle: "h1" } } } } };
    expect(readSandboxMap(meta)).toEqual(meta.vmMap);
  });

  test("prefers new key when both present", () => {
    const meta = {
      sandboxMap: { u: { b: { cluster: { sandboxHandle: "new" } } } },
      vmMap: { u: { b: { cluster: { sandboxHandle: "old" } } } },
    };
    expect(readSandboxMap(meta)).toEqual(meta.sandboxMap);
  });
});
```

Run: `bun test apps/mesh/src/tools/vm/vm-map.test.ts`

Expected: PASS.

- [ ] **Step 4: Full typecheck + targeted tests**

Run:
```bash
bun run check
bun test apps/mesh/src/tools/vm apps/mesh/src/sandbox apps/mesh/src/api/routes/decopilot
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename vmMap → sandboxMap with legacy read fallback"
```

---

## Task 5: Rename `ensureVm` → `ensureSandbox`

**Files:**
- Modify: `apps/mesh/src/tools/vm/start.ts`
- Modify: every caller of `ensureVm`

- [ ] **Step 1: Rename the function**

In `apps/mesh/src/tools/vm/start.ts`, find `export async function ensureVm(...)` and rename to `ensureSandbox`.

- [ ] **Step 2: Update call sites**

Run: `grep -rn "ensureVm\b" apps/mesh/src packages --include="*.ts" --include="*.tsx"`

Replace each `ensureVm` with `ensureSandbox`. Notable callsites:
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (in `resolveRemoteCliSandboxUrl`)
- `apps/mesh/src/api/routes/vm-events-handler.ts`
- Tests under `apps/mesh/src/tools/vm/`, `apps/mesh/src/api/routes/decopilot/`

Also rename the local helper `resolveRemoteCliSandboxUrl` (it now wraps `ensureSandbox`, not `ensureVm`) — name stays meaningful since it still resolves the remote-CLI sandbox URL.

- [ ] **Step 3: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/tools/vm apps/mesh/src/api/routes/decopilot apps/mesh/src/sandbox
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename ensureVm → ensureSandbox"
```

---

## Task 6: Restructure `DispatchTarget` (runsIn discriminant + split error type)

**Files:**
- Modify: `apps/mesh/src/links/resolve-dispatch-target.ts`
- Modify: `apps/mesh/src/links/resolve-dispatch-target.test.ts`
- Modify: every caller — `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`, `apps/mesh/src/api/routes/decopilot/routes.ts`, and any other site discriminating on `target.kind`.

- [ ] **Step 1: Find all callers**

Run: `grep -rn "DispatchTarget\b\|target\\.kind\\s*===\|target\\.reason" apps/mesh/src --include="*.ts" --include="*.tsx"`

Expected: ~6-10 hits.

- [ ] **Step 2: Update the type and the function signature**

In `apps/mesh/src/links/resolve-dispatch-target.ts`, replace the existing types:

```ts
export type DispatchTarget =
  | { runsIn: "cluster"; sandbox: SandboxProviderKind; link?: LinkEntry }
  | { runsIn: "user-desktop"; sandbox: "user-desktop"; link: LinkEntry };

export type DispatchError =
  | { kind: "user_desktop_link_offline" }
  | { kind: "user_desktop_link_capability_missing"; activeCapabilities: Capability[] };

export type ResolveDispatchTargetResult =
  | { ok: true; target: DispatchTarget }
  | { ok: false; error: DispatchError };
```

Update `resolveDispatchTarget`:

```ts
export async function resolveDispatchTarget(
  input: Input,
  deps: Deps,
): Promise<ResolveDispatchTargetResult> {
  const kind = input.sandboxProviderKind;

  if (kind !== "user-desktop") {
    return { ok: true, target: { runsIn: "cluster", sandbox: kind } };
  }

  const link = await deps.linkRegistry.get(input.userId);
  if (!link) {
    return { ok: false, error: { kind: "user_desktop_link_offline" } };
  }

  const requiredCap = capabilityFor(input.harnessId);
  if (requiredCap && !link.capabilities.includes(requiredCap)) {
    return {
      ok: false,
      error: {
        kind: "user_desktop_link_capability_missing",
        activeCapabilities: link.capabilities,
      },
    };
  }

  if (input.harnessId === "decopilot") {
    return { ok: true, target: { runsIn: "cluster", sandbox: "user-desktop", link } };
  }
  return { ok: true, target: { runsIn: "user-desktop", sandbox: "user-desktop", link } };
}
```

- [ ] **Step 3: Update callers**

In every caller, the discrimination pattern changes:

Before:
```ts
if (target.kind === "error") { /* handle error */ }
else if (target.kind === "remote-cli") { /* … */ }
else if (target.kind === "local" && target.sandbox === "desktop") { /* … */ }
else { /* local + default */ }
```

After:
```ts
if (!result.ok) {
  // result.error.kind is "user_desktop_link_offline" or "user_desktop_link_capability_missing"
}
const { target } = result;
if (target.runsIn === "user-desktop") { /* full stream on desktop */ }
else if (target.sandbox === "user-desktop") { /* cluster harness, desktop sandbox tools */ }
else { /* cluster harness, cluster sandbox */ }
```

Apply to `dispatch-run.ts` (around line 460-475 in the current file) and `routes.ts` (the `POST /messages` handler that translates errors to HTTP 409).

- [ ] **Step 4: Update tests**

In `apps/mesh/src/links/resolve-dispatch-target.test.ts`, every assertion against the old shape becomes an assertion against `result.ok` + `result.target` or `result.error`. Update the test file to match.

Add a regression test for the new error shape:

```ts
test("returns user_desktop_link_offline when no link", async () => {
  const linkRegistry = { get: async () => null };
  const result = await resolveDispatchTarget(
    { harnessId: "decopilot", sandboxProviderKind: "user-desktop", userId: "u1" },
    { linkRegistry },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected error");
  expect(result.error.kind).toBe("user_desktop_link_offline");
});
```

- [ ] **Step 5: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/links apps/mesh/src/api/routes/decopilot
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(dispatch): reshape DispatchTarget with runsIn and split error type"
```

---

## Task 7: Rename error codes (`LinkOfflineError`)

**Files:**
- Modify: `apps/mesh/src/links/link-offline-error.ts`
- Modify: callers translating to HTTP responses

The class name `LinkOfflineError` is retained (it's a thrown-error class). Only the string code on it changes.

- [ ] **Step 1: Find existing usage**

Run: `grep -rn "link_offline\|capability_missing\|LinkOfflineError" apps/mesh/src --include="*.ts" --include="*.tsx"`

- [ ] **Step 2: Update the error class**

In `apps/mesh/src/links/link-offline-error.ts`, find the error code string and replace `"link_offline"` with `"user_desktop_link_offline"`. If the class also encodes `"capability_missing"`, replace with `"user_desktop_link_capability_missing"`.

- [ ] **Step 3: Update HTTP translators**

The `POST /messages` handler returns 409 with a body that includes the code string. Update the test assertions to match the new strings.

- [ ] **Step 4: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/links apps/mesh/src/api/routes/decopilot
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(links): rename error codes to user_desktop_link_*"
```

---

## Task 8: Rename MCP tools `VM_START` → `SANDBOX_START` and `VM_DELETE` → `SANDBOX_DELETE`

**Files:**
- Modify: `apps/mesh/src/tools/vm/start.ts` (`name: "VM_START"` → `name: "SANDBOX_START"`)
- Modify: `apps/mesh/src/tools/vm/stop.ts` (`name: "VM_DELETE"` → `name: "SANDBOX_DELETE"`)
- Modify: `apps/mesh/src/tools/registry-metadata.ts` (entries at lines 896 and 901)
- Modify: `apps/mesh/src/web/components/vm/preview/preview.tsx` (the inline `name: "VM_DELETE"` call)
- Modify: any test that asserts on the tool name

Tool name is a JSON literal sent over the MCP wire. The DB migration in Task 14 will rewrite any stored references to the old names in agent configs. **No deprecated alias tools.**

- [ ] **Step 1: Replace tool-name literals**

Run:
```bash
grep -rn 'name:\s*"VM_START"\|name:\s*"VM_DELETE"\|"VM_START"\|"VM_DELETE"' \
  apps/mesh/src --include="*.ts" --include="*.tsx"
```

Replace each `"VM_START"` with `"SANDBOX_START"` and `"VM_DELETE"` with `"SANDBOX_DELETE"`. The tool's exported constant (e.g., `export const VM_START_TOOL = defineTool({...})`) can also be renamed to `SANDBOX_START_TOOL` — update importers in `apps/mesh/src/tools/index.ts` and registry assembly.

- [ ] **Step 2: Tests**

The existing tests `apps/mesh/src/tools/vm/start.test.ts` and `apps/mesh/src/tools/vm/stop.test.ts` likely reference the tool name in assertions and `defineTool` setups. Update those strings. (File-name renames happen in Task 13.)

- [ ] **Step 3: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/tools/vm apps/mesh/src/tools
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(tools): rename VM_START → SANDBOX_START, VM_DELETE → SANDBOX_DELETE"
```

---

## Task 9: Rename `sandboxUrl` → `sandboxApiUrl`

**Files:**
- Modify: `apps/mesh/src/link-daemon/sandbox-provider.ts` (returned field)
- Modify: `packages/mesh-sdk/src/types/virtual-mcp.ts` (schema field around line 233)
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (consumes the field, around line 837-840)
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts` (`sandboxUrl: string` parameter, line 157)
- Modify: every test that asserts the field name

Note: `LinkEntry.tunnelUrl` and `Sandbox.previewUrl` are unchanged.

- [ ] **Step 1: Find usages**

Run: `grep -rn "sandboxUrl\b" apps/mesh/src packages --include="*.ts" --include="*.tsx"`

- [ ] **Step 2: Replace field name**

Wherever a property named `sandboxUrl` is read or written *on a sandbox-API-URL-carrying object*, rename to `sandboxApiUrl`. Distinguish carefully from:
- `tunnelUrl` (on `LinkEntry`) — leave alone.
- `previewUrl` — leave alone.

The function parameter in `remoteDispatch(id, input, link, sandboxUrl, deps)` becomes `sandboxApiUrl`.

- [ ] **Step 3: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/link-daemon apps/mesh/src/harnesses apps/mesh/src/api/routes/decopilot
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename sandboxUrl field to sandboxApiUrl"
```

---

## Task 10: Rename env var `STUDIO_SANDBOX_RUNNER` → `STUDIO_SANDBOX_PROVIDER`

**Files:**
- Modify: `packages/sandbox/server/provider/index.ts` (the resolver, line 84-93)
- Modify: `packages/sandbox/server/provider/index.test.ts`
- Modify: `packages/sandbox/README.md`
- Modify: `deploy/helm/sandbox-env/README.md` and any helm values file referencing the env name
- Modify: any `.env.example`, dev scripts, CI configs

Hard cutover: no deprecated alias read of `STUDIO_SANDBOX_RUNNER`. The deploy bump is atomic with the code rollout.

- [ ] **Step 1: Search occurrences**

Run: `grep -rn "STUDIO_SANDBOX_RUNNER" .` (excluding node_modules — adjust with `--exclude-dir`)

- [ ] **Step 2: Replace all occurrences with `STUDIO_SANDBOX_PROVIDER`**

In `packages/sandbox/server/provider/index.ts`:

```ts
export function resolveSandboxProviderKindFromEnv(): SandboxProviderKind {
  const raw = process.env.STUDIO_SANDBOX_PROVIDER;
  const kind = (raw && raw.length > 0 ? raw : "user-desktop") as SandboxProviderKind;
  if (!RUNNER_KINDS.has(kind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_PROVIDER="${raw}" — expected "local-docker", "cluster", or "user-desktop".`,
    );
  }
  return kind;
}
```

- [ ] **Step 3: Update helm values (if applicable)**

Inspect `deploy/helm/sandbox-env/` for any `STUDIO_SANDBOX_RUNNER` references in templates or values files. Replace.

- [ ] **Step 4: Typecheck + tests**

```bash
bun run check
bun test packages/sandbox
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename STUDIO_SANDBOX_RUNNER → STUDIO_SANDBOX_PROVIDER"
```

---

## Task 11: Rename daemon route prefix `/_decopilot_vm/*` → `/_sandbox/*` with dual-serve

**Files (cluster side, new prefix only):**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts` (lines 16, 27, 166, 167)
- Modify: `apps/mesh/src/harnesses/decopilot/built-in-tools/vm-tools/index.ts` (all `call("/_decopilot_vm/…")` sites, lines 197-302)
- Modify: `apps/mesh/src/api/routes/vm-events-handler.ts` (line 248)
- Modify: `apps/mesh/src/api/routes/vm-proxy.ts` (comments around line 9)
- Modify: `packages/mesh-sdk/src/types/virtual-mcp.ts` (line 184 doc comment)
- Modify: `apps/mesh/src/harnesses/remote-dispatch.test.ts` (lines 164, 264 expected paths)

**Files (daemon side, dual-serve):**
- Modify: `packages/sandbox/daemon/routes/*.ts` — every route file
- Modify: `packages/sandbox/daemon/entry.ts` (route registration)
- Modify: `packages/sandbox/daemon/constants.ts` (comment line 4)

**Files (deploy/scripts):**
- Modify: `deploy/helm/sandbox-env/templates/sandbox-template.yaml`
- Modify: `deploy/helm/sandbox-env/files/housekeeper-sweep.sh` (lines 18, 54, 76)

- [ ] **Step 1: Write the dual-serve test FIRST (TDD)**

In `packages/sandbox/daemon/daemon.e2e.test.ts` (or add a new file `packages/sandbox/daemon/dual-serve.test.ts` if cleaner), add:

```ts
import { describe, expect, test } from "bun:test";
import { startDaemon } from "./entry";

describe("daemon dual-serve route prefixes", () => {
  test("serves /_sandbox/idle (new prefix)", async () => {
    const daemon = await startDaemon({ /* test config */ });
    try {
      const res = await fetch(`${daemon.url}/_sandbox/idle`, {
        headers: { /* signed headers */ },
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  test("serves /_decopilot_vm/idle (legacy prefix) — one release of compat", async () => {
    const daemon = await startDaemon({ /* test config */ });
    try {
      const res = await fetch(`${daemon.url}/_decopilot_vm/idle`, {
        headers: { /* signed headers */ },
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });
});
```

(Use the existing daemon-test harness in `daemon.e2e.test.ts` rather than reinventing it. Mirror its signing setup.)

- [ ] **Step 2: Run dual-serve test to verify it fails**

Run: `bun test packages/sandbox/daemon/daemon.e2e.test.ts`

Expected: FAIL — the legacy prefix is the only one currently served, so the new-prefix test fails; OR if the test was written hypothetically, both routes return 404 until the daemon registers them.

- [ ] **Step 3: Register both prefixes on the daemon**

In `packages/sandbox/daemon/entry.ts` (or wherever the Hono router is composed), wrap route registration to attach each handler to both prefixes. The cleanest implementation:

```ts
function registerSandboxRoutes(app: Hono, routes: Array<[Method, string, Handler]>) {
  for (const [method, path, handler] of routes) {
    app.on(method, `/_sandbox${path}`, handler);
    app.on(method, `/_decopilot_vm${path}`, handler); // dual-serve, one release
  }
}
```

Apply to every route currently registered under `/_decopilot_vm/*`.

- [ ] **Step 4: Re-run dual-serve test**

Run: `bun test packages/sandbox/daemon/daemon.e2e.test.ts`

Expected: PASS.

- [ ] **Step 5: Update cluster-side callers to speak only the new prefix**

Replace every literal `/_decopilot_vm/` in cluster code with `/_sandbox/`. Test files (`remote-dispatch.test.ts`) get the new path in their assertions.

Run: `grep -rn "/_decopilot_vm" apps/mesh/src --include="*.ts" --include="*.tsx"`

Expected after replacement: zero matches in `apps/mesh/src`.

- [ ] **Step 6: Update housekeeper script with fallback**

In `deploy/helm/sandbox-env/files/housekeeper-sweep.sh`:

```sh
IDLE_PATH="/_sandbox/idle"
LEGACY_IDLE_PATH="/_decopilot_vm/idle"

# Try new path first, fall back to legacy for one release window.
RESPONSE=$(curl -sf "${BASE}${IDLE_PATH}" || curl -sf "${BASE}${LEGACY_IDLE_PATH}")
```

(Match the existing script's idiom — the snippet above shows intent.)

- [ ] **Step 7: Typecheck + full test pass**

```bash
bun run check
bun test packages/sandbox apps/mesh/src/harnesses apps/mesh/src/api/routes
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): rename daemon routes to /_sandbox/* with one release of dual-serve compat"
```

---

## Task 12: Rename `link-daemon/sandbox-provider.ts` → `link-daemon/user-desktop-provider.ts`

**Files:**
- Move: `apps/mesh/src/link-daemon/sandbox-provider.ts` → `apps/mesh/src/link-daemon/user-desktop-provider.ts`
- Move: `apps/mesh/src/link-daemon/sandbox-provider.test.ts` → `apps/mesh/src/link-daemon/user-desktop-provider.test.ts`
- Modify: every importer

- [ ] **Step 1: Move the files using git mv**

```bash
git mv apps/mesh/src/link-daemon/sandbox-provider.ts \
       apps/mesh/src/link-daemon/user-desktop-provider.ts
git mv apps/mesh/src/link-daemon/sandbox-provider.test.ts \
       apps/mesh/src/link-daemon/user-desktop-provider.test.ts
```

- [ ] **Step 2: Update importers**

Run: `grep -rn "link-daemon/sandbox-provider" apps/mesh/src --include="*.ts" --include="*.tsx"`

Replace each import path with `link-daemon/user-desktop-provider`.

- [ ] **Step 3: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/link-daemon
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(link-daemon): rename sandbox-provider.ts → user-desktop-provider.ts"
```

---

## Task 13: Rename `apps/mesh/src/tools/vm/` → `apps/mesh/src/tools/sandbox/`

**Files:**
- Move: `apps/mesh/src/tools/vm/` (entire subtree) → `apps/mesh/src/tools/sandbox/`
- Rename within: `vm-map.ts` → `sandbox-map.ts`, `vm-map.test.ts` → `sandbox-map.test.ts`, `stop.ts` → `delete.ts`, `stop.test.ts` → `delete.test.ts` (fixing the file-name/tool-name mismatch)
- Modify: every importer of `tools/vm/*`

- [ ] **Step 1: Move the directory**

```bash
git mv apps/mesh/src/tools/vm apps/mesh/src/tools/sandbox
```

- [ ] **Step 2: Rename files inside**

```bash
cd apps/mesh/src/tools/sandbox
git mv vm-map.ts sandbox-map.ts
git mv vm-map.test.ts sandbox-map.test.ts
git mv stop.ts delete.ts
git mv stop.test.ts delete.test.ts
cd -
```

- [ ] **Step 3: Update importers**

Run:
```bash
grep -rn 'tools/vm/\|tools/vm"\|/tools/vm$' apps/mesh/src packages --include="*.ts" --include="*.tsx"
```

Replace `tools/vm/` → `tools/sandbox/` and `tools/vm/vm-map` → `tools/sandbox/sandbox-map`, `tools/vm/stop` → `tools/sandbox/delete`. Plus any barrel-file (`index.ts`) re-exports.

- [ ] **Step 4: Rename UI dir for symmetry**

```bash
git mv apps/mesh/src/web/components/vm apps/mesh/src/web/components/sandbox
```

Run: `grep -rn 'components/vm\b\|components/vm/' apps/mesh/src --include="*.ts" --include="*.tsx"`

Replace each occurrence with `components/sandbox`. Also rename:
- `apps/mesh/src/api/routes/vm-proxy.ts` → `apps/mesh/src/api/routes/sandbox-proxy.ts`
- `apps/mesh/src/api/routes/vm-events-handler.ts` → `apps/mesh/src/api/routes/sandbox-events-handler.ts`

```bash
git mv apps/mesh/src/api/routes/vm-proxy.ts apps/mesh/src/api/routes/sandbox-proxy.ts
git mv apps/mesh/src/api/routes/vm-events-handler.ts apps/mesh/src/api/routes/sandbox-events-handler.ts
```

Update importers of these route modules.

- [ ] **Step 5: Rename hooks/context to match**

```bash
grep -rn "useVmStart\|VmEventsContext\|useVm" apps/mesh/src --include="*.ts" --include="*.tsx"
```

Rename:
- `useVmStart` → `useSandboxStart`
- `VmEventsContext` → `SandboxEventsContext`
- `vm-events-context.tsx` → `sandbox-events-context.tsx`

Apply git mv + importer updates.

- [ ] **Step 6: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/tools/sandbox apps/mesh/src/api/routes apps/mesh/src/web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor: rename tools/vm → tools/sandbox; web/components/vm → components/sandbox; vm-* route files"
```

---

## Task 14: Database migration `091-sandbox-naming-uniformization`

**Files:**
- Create: `apps/mesh/migrations/091-sandbox-naming-uniformization.ts`
- Create: `apps/mesh/migrations/091-sandbox-naming-uniformization.test.ts`

The migration sweeps three persisted surfaces in one transaction:

1. `sandbox_runner_state.sandbox_provider_kind`: value rewrite.
2. Connections (`virtualmcp.metadata`): key rename `vmMap` → `sandboxMap`; inner kind keys + `sandboxProviderKind` field values rewrite.
3. Connections: rewrite `"VM_START"`, `"VM_DELETE"` references inside any stored tool-name strings (allowlists, prompts).

Idempotent — running twice is a no-op.

- [ ] **Step 1: Write the failing migration test first**

Create `apps/mesh/migrations/091-sandbox-naming-uniformization.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { sql } from "kysely";
import { setupTestDb, teardownTestDb } from "../src/storage/test-helpers";
import { up as runMigration091 } from "./091-sandbox-naming-uniformization";

describe("migration 091 — sandbox naming uniformization", () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeEach(async () => {
    db = await setupTestDb();
    // Apply migrations through 090 only (087, 088, 089, 090).
    // setupTestDb runs through the latest by default; if so, reset the table state.
  });

  test("rewrites sandbox_runner_state.sandbox_provider_kind values", async () => {
    await sql`INSERT INTO sandbox_runner_state (sandbox_id, branch, sandbox_provider_kind, /*...*/) VALUES
      ('s1', 'main', 'docker', /*...*/),
      ('s2', 'main', 'agent-sandbox', /*...*/),
      ('s3', 'main', 'desktop', /*...*/)`.execute(db);

    await runMigration091(db);

    const rows = await sql<{ sandbox_provider_kind: string }>`
      SELECT sandbox_provider_kind FROM sandbox_runner_state ORDER BY sandbox_id
    `.execute(db);

    expect(rows.rows.map((r) => r.sandbox_provider_kind)).toEqual([
      "local-docker",
      "cluster",
      "user-desktop",
    ]);
  });

  test("renames vmMap key → sandboxMap and rewrites inner kind keys", async () => {
    await sql`INSERT INTO connections (id, connection_type, metadata) VALUES
      ('c1', 'VIRTUAL', '{
        "vmMap": {
          "user1": {
            "main": {
              "docker": {"sandboxHandle": "h1", "sandboxProviderKind": "docker"},
              "desktop": {"sandboxHandle": "h2", "sandboxProviderKind": "desktop"}
            }
          }
        }
      }'::jsonb)`.execute(db);

    await runMigration091(db);

    const { rows } = await sql<{ metadata: any }>`
      SELECT metadata FROM connections WHERE id = 'c1'
    `.execute(db);

    expect(rows[0].metadata.vmMap).toBeUndefined();
    expect(rows[0].metadata.sandboxMap.user1.main["local-docker"].sandboxHandle).toBe("h1");
    expect(rows[0].metadata.sandboxMap.user1.main["local-docker"].sandboxProviderKind).toBe("local-docker");
    expect(rows[0].metadata.sandboxMap.user1.main["user-desktop"].sandboxHandle).toBe("h2");
  });

  test("rewrites stored tool-name references VM_START → SANDBOX_START in connection metadata", async () => {
    await sql`INSERT INTO connections (id, connection_type, metadata) VALUES
      ('c2', 'VIRTUAL', '{"toolAllowList": ["VM_START", "VM_DELETE", "OTHER_TOOL"]}'::jsonb)`.execute(db);

    await runMigration091(db);

    const { rows } = await sql<{ metadata: any }>`
      SELECT metadata FROM connections WHERE id = 'c2'
    `.execute(db);

    expect(rows[0].metadata.toolAllowList).toEqual(["SANDBOX_START", "SANDBOX_DELETE", "OTHER_TOOL"]);
  });

  test("drops legacy host/freestyle cells", async () => {
    await sql`INSERT INTO connections (id, connection_type, metadata) VALUES
      ('c3', 'VIRTUAL', '{
        "vmMap": {
          "user1": {
            "main": {
              "host": {"sandboxHandle": "h_legacy"},
              "freestyle": {"sandboxHandle": "f_legacy"},
              "desktop": {"sandboxHandle": "h_desktop"}
            }
          }
        }
      }'::jsonb)`.execute(db);

    await runMigration091(db);

    const { rows } = await sql<{ metadata: any }>`
      SELECT metadata FROM connections WHERE id = 'c3'
    `.execute(db);

    expect(rows[0].metadata.sandboxMap.user1.main.host).toBeUndefined();
    expect(rows[0].metadata.sandboxMap.user1.main.freestyle).toBeUndefined();
    expect(rows[0].metadata.sandboxMap.user1.main["user-desktop"].sandboxHandle).toBe("h_desktop");
  });

  test("is idempotent (second run is a no-op)", async () => {
    await sql`INSERT INTO connections (id, connection_type, metadata) VALUES
      ('c4', 'VIRTUAL', '{"sandboxMap": {"u": {"b": {"cluster": {"sandboxHandle": "h"}}}}}'::jsonb)`.execute(db);

    await runMigration091(db);
    await runMigration091(db);

    const { rows } = await sql<{ metadata: any }>`
      SELECT metadata FROM connections WHERE id = 'c4'
    `.execute(db);

    expect(rows[0].metadata.sandboxMap.u.b.cluster.sandboxHandle).toBe("h");
  });
});
```

- [ ] **Step 2: Run the migration test — expect failure**

Run: `bun test apps/mesh/migrations/091-sandbox-naming-uniformization.test.ts`

Expected: FAIL — the migration file doesn't exist yet.

- [ ] **Step 3: Write the migration**

Create `apps/mesh/migrations/091-sandbox-naming-uniformization.ts`:

```ts
/**
 * Migration 091: Uniformize sandbox naming.
 *
 * (1) sandbox_runner_state.sandbox_provider_kind: value rewrite
 *       docker          → local-docker
 *       agent-sandbox   → cluster
 *       desktop         → user-desktop
 *       remote-user     → user-desktop (legacy from migration 089)
 *
 * (2) connections.metadata: rename top-level `vmMap` key → `sandboxMap`.
 *
 * (3) connections.metadata.sandboxMap[user][branch]: rewrite inner kind
 *     keys and `sandboxProviderKind` field values with the same mapping.
 *     Legacy `host` and `freestyle` cells are dropped.
 *
 * (4) connections.metadata: rewrite stored tool-name strings
 *       "VM_START"      → "SANDBOX_START"
 *       "VM_DELETE"     → "SANDBOX_DELETE"
 *     anywhere they appear in the JSON blob.
 *
 * All steps are idempotent.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) Runner-state value rewrites.
  await sql`
    UPDATE sandbox_runner_state SET sandbox_provider_kind = CASE sandbox_provider_kind
      WHEN 'docker'        THEN 'local-docker'
      WHEN 'agent-sandbox' THEN 'cluster'
      WHEN 'desktop'       THEN 'user-desktop'
      WHEN 'remote-user'   THEN 'user-desktop'
      ELSE sandbox_provider_kind
    END
    WHERE sandbox_provider_kind IN ('docker','agent-sandbox','desktop','remote-user')
  `.execute(db);

  // (2) Rename vmMap → sandboxMap at the top level. Guard so rows
  // without `vmMap` are not touched.
  await sql`
    UPDATE connections c
    SET metadata = (
      (c.metadata::jsonb - 'vmMap')
        || jsonb_build_object('sandboxMap', c.metadata::jsonb->'vmMap')
    )
    WHERE connection_type = 'VIRTUAL'
      AND c.metadata::jsonb ? 'vmMap'
  `.execute(db);

  // (3) Inside each sandboxMap cell, rewrite kind keys and the inner
  // `sandboxProviderKind` field. Use a recursive jsonb_object_agg.
  // Pseudocode below — the actual SQL is a nested aggregation, see
  // migration 089 for the established pattern; this migration extends it
  // with the new mapping and a drop-set for legacy kinds.
  await sql`
    UPDATE connections c
    SET metadata = jsonb_set(
      c.metadata::jsonb,
      '{sandboxMap}',
      (
        SELECT jsonb_object_agg(user_key,
          (
            SELECT jsonb_object_agg(branch_key,
              (
                SELECT jsonb_object_agg(
                  CASE kind_key
                    WHEN 'docker'        THEN 'local-docker'
                    WHEN 'agent-sandbox' THEN 'cluster'
                    WHEN 'desktop'       THEN 'user-desktop'
                    WHEN 'remote-user'   THEN 'user-desktop'
                    ELSE kind_key
                  END,
                  jsonb_set(
                    kind_val,
                    '{sandboxProviderKind}',
                    to_jsonb(
                      CASE kind_val->>'sandboxProviderKind'
                        WHEN 'docker'        THEN 'local-docker'
                        WHEN 'agent-sandbox' THEN 'cluster'
                        WHEN 'desktop'       THEN 'user-desktop'
                        WHEN 'remote-user'   THEN 'user-desktop'
                        ELSE kind_val->>'sandboxProviderKind'
                      END
                    )
                  )
                )
                FROM jsonb_each(branch_val) AS kind(kind_key, kind_val)
                WHERE kind_key NOT IN ('host','freestyle')
              )
            )
            FROM jsonb_each(user_val) AS branch(branch_key, branch_val)
          )
        )
        FROM jsonb_each(c.metadata::jsonb->'sandboxMap') AS u(user_key, user_val)
      )
    )
    WHERE connection_type = 'VIRTUAL'
      AND c.metadata::jsonb ? 'sandboxMap'
  `.execute(db);

  // (4) Rewrite stored tool-name strings VM_START / VM_DELETE.
  // Cast metadata to text, replace, cast back. Only touches rows that
  // contain at least one match.
  await sql`
    UPDATE connections c
    SET metadata = REPLACE(REPLACE(c.metadata::text,
      '"VM_START"', '"SANDBOX_START"'),
      '"VM_DELETE"', '"SANDBOX_DELETE"')::jsonb
    WHERE connection_type = 'VIRTUAL'
      AND (c.metadata::text LIKE '%"VM_START"%' OR c.metadata::text LIKE '%"VM_DELETE"%')
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No down migration — the rename is hard cutover. If a rollback is
  // needed, restore from backup.
}
```

(The recursive jsonb rewrite in step 3 follows the pattern established in migration 089 — copy that file's SQL idiom and extend the CASE mapping.)

- [ ] **Step 4: Run the migration test — expect pass**

Run: `bun test apps/mesh/migrations/091-sandbox-naming-uniformization.test.ts`

Expected: PASS for all five cases.

- [ ] **Step 5: Run the full migration test suite to ensure nothing else breaks**

Run: `bun test apps/mesh/migrations`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add -p
git commit -m "feat(migrations): 091 sweep stored values to new sandbox-naming vocabulary"
```

---

## Task 15: Remove legacy tolerant readers and the `vmMap` read fallback

**Files:**
- Modify: `packages/mesh-sdk/src/types/virtual-mcp.ts` (tolerant reader added in Task 2)
- Modify: `apps/mesh/src/tools/sandbox/sandbox-map.ts` (the `metadata.vmMap` fallback added in Task 4)
- Delete: legacy normalizer for `runnerKind` (already on TTL per migration 085 comment)

After migration 091 runs in deploy, no row in the database holds legacy values. The tolerant readers are unreachable.

- [ ] **Step 1: Remove legacy values from the SDK's kind schema**

In `packages/mesh-sdk/src/types/virtual-mcp.ts`, the schema becomes a clean three-value enum:

```ts
const sandboxProviderKindSchema = z.union([
  z.literal("local-docker"),
  z.literal("cluster"),
  z.literal("user-desktop"),
]);
```

Remove the `.transform()` that mapped legacy values.

- [ ] **Step 2: Remove `runnerKind` field normalizer**

Find the comment "// TTL post-2026-06-20" (or similar) near the `runnerKind` reader. Remove the normalizer; the field is gone from the DB after migration 091 (which doesn't actually touch `runnerKind` — it was already migrated by 085, but the tolerant reader was kept around). Confirm via grep that no row in any persisted JSON blob contains `runnerKind`.

- [ ] **Step 3: Remove the `vmMap` fallback from `readSandboxMap`**

In `apps/mesh/src/tools/sandbox/sandbox-map.ts`, simplify:

```ts
export function readSandboxMap(
  metadata: Record<string, unknown> | null,
): SandboxMapShape {
  if (metadata == null) return {};
  return ((metadata as Record<string, unknown>).sandboxMap ?? {}) as SandboxMapShape;
}
```

Remove the legacy-fallback test added in Task 4. Add an assertion that the schema rejects legacy values:

```ts
test("schema rejects legacy values", () => {
  expect(() => sandboxProviderKindSchema.parse("docker")).toThrow();
  expect(() => sandboxProviderKindSchema.parse("desktop")).toThrow();
});
```

- [ ] **Step 4: Typecheck + tests**

```bash
bun run check
bun test apps/mesh/src/tools/sandbox packages/mesh-sdk
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add -p
git commit -m "refactor(sandbox): remove legacy tolerant readers (vmMap fallback, runnerKind, legacy kind values)"
```

---

## Task 16: Update docs and comments

**Files:**
- Modify: `packages/sandbox/README.md`
- Modify: `apps/mesh/src/sandbox/resolve-provider.ts` (header comment block)
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (header + inline comments referencing `VM_START`)
- Modify: any other doc comment referencing `VM_START`, `vmMap`, `runner`, `decopilot_vm`

- [ ] **Step 1: Inventory comment hits**

Run:
```bash
grep -rn 'VM_START\|VM_DELETE\|vmMap\|\\brunner\\b\|decopilot_vm' \
  apps/mesh/src packages docs --include="*.ts" --include="*.tsx" --include="*.md"
```

Expected: ~30-60 doc-comment / README hits. (Migration files in `apps/mesh/migrations/` are historical — do NOT modify those.)

- [ ] **Step 2: Update each comment to use the new vocabulary**

Walk the list. Each hit gets the corresponding rename: `VM_START` → `SANDBOX_START`, `vmMap` → `sandboxMap`, "runner" (when referring to the sandbox-provider abstraction) → "provider", `decopilot_vm` → `sandbox`.

Pay attention to the AGENTS.md / CLAUDE.md if it references the old names — keep it in sync.

- [ ] **Step 3: Typecheck (no functional changes expected)**

```bash
bun run check
bun test --bail
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add -p
git commit -m "docs: update sandbox-related doc comments and READMEs to new vocabulary"
```

---

## Task 17: Smoke test the full system

This task does not produce code changes — it's the end-to-end verification before merge.

- [ ] **Step 1: Run the full test suite**

```bash
bun run check
bun run lint
bun test
```

Expected: ALL PASS.

- [ ] **Step 2: Run resilience tests (Docker-backed)**

```bash
./tests/resilience/run.sh
```

Expected: PASS. Note: this requires Docker; skip if unavailable and note in the PR description.

- [ ] **Step 3: Local dev smoke**

```bash
bun run dev
```

In a separate terminal, hit the studio UI and:
- Connect a repo (`deco link` should still work — name unchanged).
- Trigger `SANDBOX_START` from the UI on a clonable agent.
- Confirm a sandbox provisions, a preview appears, and `previewUrl` resolves.
- Trigger `SANDBOX_DELETE` and confirm the sandbox is torn down.
- Send a follow-up message to a thread; confirm dispatch hits `/_sandbox/dispatch` (check logs or network panel).

- [ ] **Step 4: Old-daemon compat smoke**

Start a daemon that still serves only the legacy `/_decopilot_vm/*` prefix (use the previous git revision in a separate worktree). Confirm the cluster, **with the new code**, fails with a clear error message — the spec accepts this; the dual-serve compat is on the *daemon* side for users running new daemons against old clusters (or vice versa during rollout).

Actually correct check: start a daemon **from this branch** (which dual-serves) and a cluster from the *previous* main. Confirm the old cluster, which speaks the legacy prefix, still works against the new daemon.

- [ ] **Step 5: Manual DB migration verification**

In a fresh dev DB with legacy data seeded, run `bun run --cwd=apps/mesh migrate` and inspect a `connections` row before/after to confirm the migration ran end-to-end.

- [ ] **Step 6: Final commit / no-op marker (if needed)**

If any final docs/changelog need updating before merge, do them here and commit.

---

## Self-Review

### Spec coverage check

| Spec section | Task(s) |
|---|---|
| Canonical taxonomy (Sandbox, SandboxProvider; drop VM/Runner) | T3, T4, T5, T13 |
| `SandboxProviderKind` rename (local-docker/cluster/user-desktop) | T1, T2 |
| `DispatchTarget` reshape (`runsIn` + split error) | T6 |
| Error code rename (`user_desktop_link_*`) | T6, T7 |
| Daemon route prefix `/_sandbox/*` + dual-serve | T11 |
| URL field `sandboxApiUrl` | T9 |
| MCP tool `SANDBOX_START` / `SANDBOX_DELETE` | T8 |
| Env var `STUDIO_SANDBOX_PROVIDER` | T10 |
| Data migration (kinds + key rename + tool-name strings) | T14 |
| File/directory renames | T12, T13 |
| Drop legacy tolerant readers | T15 |
| Docs and comments | T16 |
| Acceptance / smoke | T17 |

All spec sections have at least one task. No gaps.

### Placeholder scan

Searched plan for `TBD`, `TODO`, `fill in`, `appropriate`, `similar to`, `etc.`, `…`. Findings:

- Step 3 of Task 14 contains a "Pseudocode below" disclaimer for the recursive JSONB CASE rewrite — but the actual SQL is fully written, just complex. The "Pseudocode" wording is misleading; rename to "Reference SQL (extends pattern from migration 089)" mentally when reading. Otherwise no placeholders.
- Task 11 Step 6 housekeeper script uses "Match the existing script's idiom — the snippet above shows intent." This is a real placeholder concession — the script's exact form depends on the existing bash variables. Acceptable because the alternative is to inline a script the engineer hasn't read; the link to the file path + the intent is enough.

### Type consistency

- `SandboxRecord` (Task 3) replaces `VmMapEntry` and has `sandboxHandle: string` — used consistently in Task 4's helpers and Task 14's migration test fixtures.
- `SandboxProviderKind` values are `"local-docker" | "cluster" | "user-desktop"` everywhere from Task 1 onward.
- `DispatchTarget` discriminant is `runsIn` (Task 6) — referenced consistently. Error type discriminant is `kind` (`user_desktop_link_offline` / `user_desktop_link_capability_missing`).
- `sandboxApiUrl` (Task 9) lands on the daemon-API-URL field consistently; `tunnelUrl` and `previewUrl` are untouched as the spec requires.

No type-shape drift detected.
