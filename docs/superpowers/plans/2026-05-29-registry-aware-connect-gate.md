# Registry-aware connect gate with inline connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Connect to use this agent" gate show each unresolved slot's real MCP icon + friendly name (from the registry) and let the user connect the app inline (OAuth in place) without leaving the gate.

**Architecture:** A new suspending hook (`useSlotAppDisplays`) batches one `COLLECTION_REGISTRY_APP_GET` per slot so the gate renders fully-formed. A shared async `connectApp()` core (factored out of `add-connection-dialog.tsx`'s `handleConnectAndAdd`) performs create → OAuth → token-persist. A `useConnectApp()` hook wraps it with per-row status, and a new `ConnectSlotRow` component renders each slot — registry rows get inline connect, non-registry/synthetic rows keep today's deep-link.

**Tech Stack:** React 19 (no `useEffect`/`useMemo` per repo rules), TanStack Query (`useSuspenseQuery`), `@decocms/mesh-sdk` MCP client, Bun test runner, Biome formatting.

---

## File Structure

- Create `apps/mesh/src/web/hooks/slot-app-display.ts` — pure `slotAppDisplay(slotAppId, registryItem | null)` mapper + types. **Unit-tested.**
- Create `apps/mesh/src/web/hooks/slot-app-display.test.ts` — unit tests for the mapper.
- Create `apps/mesh/src/web/hooks/use-slot-app-displays.ts` — batched, suspending registry-metadata hook.
- Create `apps/mesh/src/web/lib/connect-app.ts` — shared async inline-connect pipeline (no React).
- Create `apps/mesh/src/web/hooks/use-connect-app.ts` — React hook wrapping `connectApp` with status/error.
- Create `apps/mesh/src/web/components/chat/connect-slot-row.tsx` — one gate row (registry vs fallback).
- Modify `apps/mesh/src/web/components/chat/connect-agent-gate.tsx` — use `useSlotAppDisplays`, render `ConnectSlotRow`.
- Modify `apps/mesh/src/web/lib/query-keys.ts` — add `slotAppDisplays` key.
- Modify `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx` — `handleConnectAndAdd` delegates to `connectApp` (DRY).

---

## Task 1: Pure `slotAppDisplay` mapper + unit tests

**Files:**
- Create: `apps/mesh/src/web/hooks/slot-app-display.ts`
- Test: `apps/mesh/src/web/hooks/slot-app-display.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/web/hooks/slot-app-display.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { RegistryItem } from "@/web/components/store/types";
import { slotAppDisplay } from "./slot-app-display";

describe("slotAppDisplay", () => {
  it("falls back to the raw app_id when there is no registry item", () => {
    expect(slotAppDisplay("url:api.acme.com/mcp", null)).toEqual({
      kind: "fallback",
      title: "url:api.acme.com/mcp",
      icon: null,
    });
  });

  it("uses the registry friendly name and icon when present", () => {
    const item = {
      _meta: { "mcp.mesh": { friendlyName: "GitHub" } },
      server: { icons: [{ src: "https://cdn/github.png" }] },
    } as unknown as RegistryItem;
    expect(slotAppDisplay("deco/mcp-github", item)).toEqual({
      kind: "registry",
      title: "GitHub",
      icon: "https://cdn/github.png",
    });
  });

  it("falls through to server.title and null icon when friendly name/icon are missing", () => {
    const item = {
      _meta: {},
      server: { title: "Linear MCP" },
    } as unknown as RegistryItem;
    expect(slotAppDisplay("deco/mcp-linear", item)).toEqual({
      kind: "registry",
      title: "Linear MCP",
      icon: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/hooks/slot-app-display.test.ts`
Expected: FAIL — `Cannot find module './slot-app-display'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mesh/src/web/hooks/slot-app-display.ts`:

```ts
/**
 * Decides how to display one of an agent's unresolved typed slots in the
 * connect gate. A slot carries only `slot_app_id`; when the registry knows the
 * app we show its friendly name + icon and allow inline connect, otherwise we
 * fall back to the raw app_id (synthetic `url:`/`stdio:`/`npx:` ids, or unknown
 * apps), which can only be connected via the connections page.
 */
import type { RegistryItem } from "@/web/components/store/types";
import { MCP_MESH_DECOCMS_KEY } from "@/web/utils/constants";

export interface SlotAppDisplay {
  kind: "registry" | "fallback";
  title: string;
  icon: string | null;
}

export function slotAppDisplay(
  slotAppId: string,
  item: RegistryItem | null,
): SlotAppDisplay {
  if (!item) {
    return { kind: "fallback", title: slotAppId, icon: null };
  }
  const meshMeta = item._meta?.[MCP_MESH_DECOCMS_KEY];
  const title =
    meshMeta?.friendlyName ||
    meshMeta?.friendly_name ||
    item.title ||
    item.server?.title ||
    item.server?.name ||
    slotAppId;
  const icon = item.server?.icons?.[0]?.src ?? null;
  return { kind: "registry", title, icon };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/hooks/slot-app-display.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/hooks/slot-app-display.ts apps/mesh/src/web/hooks/slot-app-display.test.ts
git commit -m "feat(chat): add slotAppDisplay registry-metadata mapper for the connect gate"
```

---

## Task 2: `slotAppDisplays` query key + `useSlotAppDisplays` suspending hook

**Files:**
- Modify: `apps/mesh/src/web/lib/query-keys.ts` (after the `unresolvedSlots` key, ~line 357)
- Create: `apps/mesh/src/web/hooks/use-slot-app-displays.ts`

- [ ] **Step 1: Add the query key**

In `apps/mesh/src/web/lib/query-keys.ts`, directly after the `unresolvedSlots` entry (the block ending at line 357), add:

```ts
  // Batched registry-metadata lookup for an agent's unresolved slots (powers
  // the connect gate's icon/name + registry-vs-fallback decision). appIds must
  // be sorted by the caller so the key is stable regardless of slot ordering.
  slotAppDisplays: (orgId: string, sortedAppIds: string[]) =>
    ["slot-app-displays", orgId, ...sortedAppIds] as const,
```

- [ ] **Step 2: Create the hook**

Create `apps/mesh/src/web/hooks/use-slot-app-displays.ts`:

```ts
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { KEYS } from "@/web/lib/query-keys";
import { type SlotAppDisplay, slotAppDisplay } from "./slot-app-display";
import type { SlotLike } from "./unresolved-slots";

export interface ResolvedSlotAppDisplay extends SlotAppDisplay {
  registryItem: RegistryItem | null;
}

/**
 * Resolves each unresolved slot's `app_id` to its registry display metadata
 * (icon + friendly name) in a single suspending query — one
 * COLLECTION_REGISTRY_APP_GET per app_id via Promise.all. Suspends (like
 * `useUnresolvedSlots`) so the gate appears fully-formed with no icon/name
 * flash. An app the registry doesn't know (synthetic id, or a failed lookup)
 * maps to a `fallback` display. Returns a map keyed by `slot_app_id`.
 */
export function useSlotAppDisplays<T extends SlotLike>(
  slots: T[],
): Record<string, ResolvedSlotAppDisplay> {
  const { org } = useProjectContext();
  const registryClient = useMCPClient({
    connectionId: WellKnownOrgMCPId.REGISTRY(org.id),
    orgId: org.id,
    orgSlug: org.slug,
  });
  const appIds = slots.map((s) => s.slot_app_id);
  const sortedAppIds = [...appIds].sort();

  const query = useSuspenseQuery({
    queryKey: KEYS.slotAppDisplays(org.id, sortedAppIds),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, ResolvedSlotAppDisplay>> => {
      const entries = await Promise.all(
        appIds.map(async (appId) => {
          let item: RegistryItem | null = null;
          try {
            const result = await registryClient.callTool({
              name: "COLLECTION_REGISTRY_APP_GET",
              arguments: { name: appId },
            });
            const structured = (
              result as { structuredContent?: { item?: RegistryItem } }
            ).structuredContent;
            item = structured?.item ?? null;
          } catch {
            // Unknown app / registry error → fallback row (deep-link), never
            // fail the whole gate.
            item = null;
          }
          return [
            appId,
            { ...slotAppDisplay(appId, item), registryItem: item },
          ] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  return query.data;
}
```

- [ ] **Step 3: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS (no type errors introduced).

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/lib/query-keys.ts apps/mesh/src/web/hooks/use-slot-app-displays.ts
git commit -m "feat(chat): add useSlotAppDisplays suspending registry-metadata hook"
```

---

## Task 3: Shared `connectApp` inline-connect core

**Files:**
- Create: `apps/mesh/src/web/lib/connect-app.ts`

This factors the create → OAuth → token-persist pipeline out of `add-connection-dialog.tsx`'s `handleConnectAndAdd` (currently ~L804-913) so the gate and the dialog share one implementation. It does **no** UI side effects (no toasts, tracking, or agent-attach) — callers layer those on.

- [ ] **Step 1: Create the module**

Create `apps/mesh/src/web/lib/connect-app.ts`:

```ts
/**
 * Shared inline-connect pipeline: turn a registry item into a created (and, if
 * needed, OAuth-authenticated) connection. No UI side effects — callers handle
 * toasts/tracking/navigation. Used by the connect gate (`useConnectApp`) and
 * the add-connection dialog.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { useConnectionActions } from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import {
  authenticateMcp,
  isConnectionAuthenticated,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { extractConnectionData } from "@/web/utils/extract-connection-data";

export interface ConnectAppDeps {
  org: { id: string; slug: string };
  userId: string;
  connectionActions: ReturnType<typeof useConnectionActions>;
  queryClient: QueryClient;
  /** Reports pipeline progress so callers can show per-phase UI. */
  onPhase?: (phase: "connecting" | "authenticating") => void;
}

export interface ConnectAppResult {
  /** The created connection id, or null if creation never happened. */
  id: string | null;
  oauth: "not-needed" | "succeeded" | "failed";
  /**
   * `"no-connection-method"` when the item has no URL/STDIO command (nothing
   * created), an OAuth error string when `oauth === "failed"`, else null.
   */
  error: string | null;
}

export async function connectApp(
  item: RegistryItem,
  deps: ConnectAppDeps,
): Promise<ConnectAppResult> {
  const { org, userId, connectionActions, queryClient, onPhase } = deps;

  const connectionData = extractConnectionData(item, org.id, userId, {
    remoteIndex: 0,
  });

  const isStdio = connectionData.connection_type === "STDIO";
  const hasUrl = Boolean(connectionData.connection_url);
  const hasStdioConfig =
    isStdio &&
    connectionData.connection_headers &&
    typeof connectionData.connection_headers === "object" &&
    "command" in connectionData.connection_headers;
  if (!hasUrl && !hasStdioConfig) {
    return { id: null, oauth: "not-needed", error: "no-connection-method" };
  }

  onPhase?.("connecting");
  const { id } = await connectionActions.create.mutateAsync(connectionData);

  const mcpProxyUrl = new URL(
    `/api/${org.slug}/mcp/${id}`,
    window.location.origin,
  );
  const authStatus = await isConnectionAuthenticated({
    url: mcpProxyUrl.href,
    token: null,
    orgId: org.id,
  });

  if (!(authStatus.supportsOAuth && !authStatus.isAuthenticated)) {
    return { id, oauth: "not-needed", error: null };
  }

  onPhase?.("authenticating");
  const { token, tokenInfo, error } = await authenticateMcp({
    connectionId: id,
    orgSlug: org.slug,
    scope: "offline_access",
  });
  if (error || !token) {
    return { id, oauth: "failed", error: error ?? "no token received" };
  }

  if (tokenInfo) {
    try {
      const response = await fetch(
        `/api/${org.slug}/connections/${id}/oauth-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            accessToken: tokenInfo.accessToken,
            refreshToken: tokenInfo.refreshToken,
            expiresIn: tokenInfo.expiresIn,
            scope: tokenInfo.scope,
            clientId: tokenInfo.clientId,
            clientSecret: tokenInfo.clientSecret,
            tokenEndpoint: tokenInfo.tokenEndpoint,
          }),
        },
      );
      if (!response.ok) {
        await connectionActions.update.mutateAsync({
          id,
          data: { connection_token: token },
        });
      } else {
        await connectionActions.update.mutateAsync({ id, data: {} });
      }
    } catch {
      await connectionActions.update.mutateAsync({
        id,
        data: { connection_token: token },
      });
    }
  } else {
    await connectionActions.update.mutateAsync({
      id,
      data: { connection_token: token },
    });
  }

  await queryClient.invalidateQueries({
    queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
  });

  return { id, oauth: "succeeded", error: null };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/lib/connect-app.ts
git commit -m "feat(connections): extract shared connectApp inline-connect pipeline"
```

---

## Task 4: `useConnectApp` hook

**Files:**
- Create: `apps/mesh/src/web/hooks/use-connect-app.ts`

- [ ] **Step 1: Create the hook**

Create `apps/mesh/src/web/hooks/use-connect-app.ts`:

```ts
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectionActions, useProjectContext } from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { authClient } from "@/web/lib/auth-client";
import { connectApp } from "@/web/lib/connect-app";

export type ConnectAppStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "ready"
  | "error";

/**
 * Drives inline connect for a single connect-gate row. `connect(item)` runs the
 * shared `connectApp` pipeline and exposes a per-row status/error. On success it
 * invalidates the slot-resolution queries so the gate re-resolves and the row
 * drops (a background refetch on the gate's suspense query — no re-suspend).
 */
export function useConnectApp(): {
  connect: (item: RegistryItem) => Promise<void>;
  status: ConnectAppStatus;
  error: string | null;
} {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectAppStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = async (item: RegistryItem) => {
    if (!session?.user?.id) return;
    setError(null);
    setStatus("connecting");
    try {
      const result = await connectApp(item, {
        org: { id: org.id, slug: org.slug },
        userId: session.user.id,
        connectionActions,
        queryClient,
        onPhase: (phase) => setStatus(phase),
      });
      if (result.error) {
        setStatus("error");
        setError(
          result.error === "no-connection-method"
            ? "This app can't be connected automatically."
            : "Couldn't connect. Try again.",
        );
        return;
      }
      // Re-resolve the gate (and settings slot rows) so this slot drops.
      await queryClient.invalidateQueries({ queryKey: ["unresolved-slots"] });
      await queryClient.invalidateQueries({
        queryKey: ["connection-resolve-for-user"],
      });
      setStatus("ready");
    } catch (err) {
      console.error("Inline connect failed:", err);
      setStatus("error");
      setError("Couldn't connect. Try again.");
    }
  };

  return { connect, status, error };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/hooks/use-connect-app.ts
git commit -m "feat(chat): add useConnectApp hook for inline connect-gate connect"
```

---

## Task 5: `ConnectSlotRow` component

**Files:**
- Create: `apps/mesh/src/web/components/chat/connect-slot-row.tsx`

- [ ] **Step 1: Create the component**

Create `apps/mesh/src/web/components/chat/connect-slot-row.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { Loading01 } from "@untitledui/icons";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useConnectApp } from "@/web/hooks/use-connect-app";
import type { ResolvedSlotAppDisplay } from "@/web/hooks/use-slot-app-displays";

/**
 * One row of the connect gate. Registry apps show their icon + friendly name and
 * connect inline (OAuth in place); non-registry / synthetic slots show the raw
 * app_id and deep-link to the connections page.
 */
export function ConnectSlotRow({
  display,
  orgSlug,
}: {
  display: ResolvedSlotAppDisplay;
  orgSlug: string;
}) {
  const { connect, status, error } = useConnectApp();
  const registryItem =
    display.kind === "registry" ? display.registryItem : null;
  const busy = status === "connecting" || status === "authenticating";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <IntegrationIcon
        icon={display.icon}
        name={display.title}
        size="sm"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{display.title}</p>
        {status === "error" && error ? (
          <p className="text-xs text-destructive truncate">{error}</p>
        ) : null}
      </div>
      {registryItem ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          disabled={busy}
          onClick={() => connect(registryItem)}
        >
          {status === "connecting" ? (
            <>
              <Loading01 className="size-3 animate-spin" />
              Connecting…
            </>
          ) : status === "authenticating" ? (
            <>
              <Loading01 className="size-3 animate-spin" />
              Authenticating…
            </>
          ) : status === "error" ? (
            "Try again"
          ) : (
            "Connect"
          )}
        </Button>
      ) : (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
        >
          <Link to="/$org/settings/connections" params={{ org: orgSlug }}>
            Connect
          </Link>
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/chat/connect-slot-row.tsx
git commit -m "feat(chat): add ConnectSlotRow with inline connect / deep-link fallback"
```

---

## Task 6: Wire `ConnectAgentGate` to use registry displays + `ConnectSlotRow`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/connect-agent-gate.tsx` (whole file)

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `apps/mesh/src/web/components/chat/connect-agent-gate.tsx` with:

```tsx
import { IntegrationIcon } from "@/web/components/integration-icon";
import { ConnectSlotRow } from "@/web/components/chat/connect-slot-row";
import { useSlotAppDisplays } from "@/web/hooks/use-slot-app-displays";
import type { SlotLike } from "@/web/hooks/unresolved-slots";

/**
 * Shown when the current user is missing one or more of the agent's required
 * personal connections (typed slots). Each row shows the app's registry icon +
 * friendly name and a Connect button: registry apps connect inline (OAuth in
 * place); synthetic / unknown apps deep-link to the Connections page. When the
 * last slot resolves, the surrounding view re-resolves and replaces this gate.
 */
export function ConnectAgentGate({
  agentTitle,
  agentIcon,
  slots,
  orgSlug,
}: {
  agentTitle: string;
  agentIcon: string | null;
  slots: SlotLike[];
  orgSlug: string;
}) {
  const displays = useSlotAppDisplays(slots);

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center justify-center gap-3 text-center max-w-md">
        <IntegrationIcon
          icon={agentIcon}
          name={agentTitle}
          size="lg"
          className="size-12 min-w-12 rounded-xl"
        />
        <h3 className="text-base md:text-xl font-medium text-foreground">
          Connect to use this agent
        </h3>
        <p className="text-muted-foreground text-sm">
          "{agentTitle}" needs your personal connections before it can run.
        </p>
      </div>
      <div className="w-full max-w-sm flex flex-col gap-2">
        {slots.map((slot) => (
          <ConnectSlotRow
            key={slot.slot_app_id}
            display={
              displays[slot.slot_app_id] ?? {
                kind: "fallback",
                title: slot.slot_app_id,
                icon: null,
                registryItem: null,
              }
            }
            orgSlug={orgSlug}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. (No more `Button`/`Link` imports in this file — they moved to `ConnectSlotRow`.)

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/chat/connect-agent-gate.tsx
git commit -m "feat(chat): render registry icon/name + inline connect in the connect gate"
```

---

## Task 7: Refactor `handleConnectAndAdd` in the dialog to use `connectApp` (DRY)

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx` (`handleConnectAndAdd`, ~L804-927; imports near top)

Goal: delete the duplicated create/OAuth/persist body and call the shared `connectApp`, preserving the dialog's existing behavior exactly (tracking, toasts, `onAdd`, and `connectingItemId` spinner state). On OAuth failure the dialog still attaches the connection and warns (unchanged).

- [ ] **Step 1: Add the import**

In `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx`, add to the imports (next to the other `@/web/lib` / `@/web/utils` imports):

```ts
import { connectApp } from "@/web/lib/connect-app";
```

- [ ] **Step 2: Replace `handleConnectAndAdd`**

Replace the entire `handleConnectAndAdd` function (the `const handleConnectAndAdd = async (item: RegistryItem) => { ... };` block, currently ~L804-927) with:

```ts
  // For catalog items with no instances: create connection + add to agent
  const handleConnectAndAdd = async (item: RegistryItem) => {
    if (!org || !session?.user?.id) return;
    setConnectingItemId(item.id);

    try {
      const result = await connectApp(item, {
        org: { id: org.id, slug: org.slug },
        userId: session.user.id,
        connectionActions,
        queryClient,
      });

      if (result.error === "no-connection-method") {
        toast.error(
          "This MCP Server cannot be connected: no connection method available",
        );
        return;
      }

      const id = result.id;
      if (!id) {
        toast.error("Failed to connect");
        return;
      }

      const appName = getRegistryItemAppName(item);

      if (result.oauth === "failed") {
        track("connection_oauth_failed", {
          connection_id: id,
          flow: "connect_new",
          error: result.error ?? "no_token",
        });
        toast.warning("Couldn't sign in to this connection", {
          description: `It was added to your agent, but its sign-in setup looks off. You can try authenticating again later from the connection's settings. (${result.error ?? "no token received"})`,
        });
        trackAttach(id, appName, "new");
        onAdd(id);
        return;
      }

      if (result.oauth === "succeeded") {
        track("connection_oauth_succeeded", {
          connection_id: id,
          flow: "connect_new",
        });
        toast.success("Connected and authenticated");
      } else {
        toast.success("Connected");
      }

      trackAttach(id, appName, "new");
      onAdd(id);
    } catch (err) {
      console.error("Failed to connect:", err);
      toast.error("Failed to connect");
    } finally {
      setConnectingItemId(null);
    }
  };
```

Notes for the implementer:
- `getRegistryItemAppName` is already imported in this file (line 25). The previous code derived `app_name` from `connectionData.app_name`; `getRegistryItemAppName(item)` yields the same canonical value (`extractConnectionData` sets `app_name` from it), so tracking is unchanged.
- `trackAttach`, `track`, `connectionActions`, `queryClient`, `org`, `session` are all already in scope in this component (defined ~L681-683 and used by the surrounding handlers).
- Do **not** touch `handleCloneAndAdd` (the other handler ~L700) — it is out of scope.
- After the edit, `authenticateMcp` / `isConnectionAuthenticated` may become unused **in this file** only if no other handler uses them. `handleCloneAndAdd` still uses both, so keep those imports. Run the lint/check in the next step to confirm no unused-import errors.

- [ ] **Step 3: Type-check and lint**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

Run: `bun run lint`
Expected: 0 errors (pre-existing warnings unrelated to these files are acceptable).

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx
git commit -m "refactor(connections): route dialog handleConnectAndAdd through shared connectApp"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the unit test**

Run: `bun test apps/mesh/src/web/hooks/slot-app-display.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2: Type-check all workspaces**

Run: `bun run check`
Expected: clean across all workspaces.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: 0 errors (pre-existing warnings in untouched files are acceptable).

- [ ] **Step 4: Format**

Run: `bun run fmt`
Expected: no remaining changes after running (commit any formatting fixes).

- [ ] **Step 5: Manual verification notes (record in the PR / hand back to user)**

Document for the user to verify in the running app (per `TESTING.md`, this is e2e/manual territory, not a unit test):
- Open a GitHub-imported agent as a user **without** GitHub connected → the gate shows the **GitHub icon + "GitHub"** (not `deco/mcp-github`) with an inline `[ Connect ]`.
- Click Connect → button shows `Connecting…` then `Authenticating…` → OAuth popup → on return the row clears; when GitHub was the only slot, the agent view appears. No full-gate flash.
- A member who already has the connection → no gate (resolved).
- An agent with a synthetic-`app_id` slot (e.g. a custom HTTP connection wired as a slot) → fallback row: raw `app_id` + a Connect that deep-links to the connections page.
- The add-connection dialog's "Connect" on a catalog item still works as before (connect + attach + toast).

- [ ] **Step 6: Commit any formatting-only changes**

```bash
git add -A
git commit -m "chore(chat): formatting for registry-aware connect gate" || echo "nothing to commit"
```

---

## Self-Review

- **Spec coverage:**
  - §1 metadata resolution (suspending, batched; registry vs fallback) → Tasks 1 (mapper) + 2 (hook).
  - §2 `useConnectApp` + factor `handleConnectAndAdd` + invalidate gate resolve query → Tasks 3 (`connectApp`), 4 (`useConnectApp`), 7 (dialog refactor).
  - §3 `ConnectSlotRow` per-row states + gate wiring → Tasks 5 + 6.
  - Testing (unit for the mapper; manual/e2e) → Tasks 1 + 8.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `SlotAppDisplay`/`slotAppDisplay` (Task 1) ↔ `ResolvedSlotAppDisplay`/`useSlotAppDisplays` (Task 2) ↔ `ConnectSlotRow` `display` prop (Task 5) ↔ gate fallback literal (Task 6) all share `{ kind, title, icon, registryItem }`. `ConnectAppResult` `{ id, oauth, error }` (Task 3) is consumed identically by `useConnectApp` (Task 4) and the dialog (Task 7). `KEYS.slotAppDisplays` (Task 2) matches the hook's `queryKey`.
</content>
