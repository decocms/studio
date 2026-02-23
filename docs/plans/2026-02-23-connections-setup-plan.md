# ConnectionsSetup Component Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `ConnectionsSetup` component that guides users through installing, authenticating, and verifying a declared set of MCP connections—used in onboarding flows and marketplace agent installs.

**Architecture:** Context-agnostic component that accepts a `Record<string, ConnectionSlot>` prop and fires `onComplete(Record<string, string>)` when all slots are satisfied. Each slot resolves against existing connections by `metadata.registry_item_id` and renders either a done card, a picker (existing connections), or an inline install+auth flow. No multi-step navigation—all slots are visible at once, satisfied slots collapse.

**Tech Stack:** React 19, TanStack React Query v5, react-hook-form + Zod, `@decocms/mesh-sdk` hooks (`useConnectionActions`, `useConnections`, `useProjectContext`, `createMCPClient`, `SELF_MCP_ALIAS_ID`, `authenticateMcp`, `isConnectionAuthenticated`), existing utilities: `extractConnectionData`, `callRegistryTool`, `extractItemsFromResponse`, `findListToolName` from `@/web/utils/`.

---

## Reference: Key Imports

```typescript
// From @decocms/mesh-sdk
import {
  useConnectionActions,
  useConnections,
  useProjectContext,
  createMCPClient,
  SELF_MCP_ALIAS_ID,
  authenticateMcp,
  isConnectionAuthenticated,
  type ConnectionEntity,
  type McpAuthStatus,
} from "@decocms/mesh-sdk";

// Internal utilities
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import {
  callRegistryTool,
  extractItemsFromResponse,
  findListToolName,
} from "@/web/utils/registry-utils";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { KEYS } from "@/web/lib/query-keys";

// React Query
import { useQuery, useQueryClient } from "@tanstack/react-query";

// Auth
import { authClient } from "@/web/lib/auth-client";

// Types
import type { RegistryItem } from "@/web/components/store/types";
```

## Reference: Slot Types

```typescript
// Defined in connections-setup.tsx and re-exported via index.ts
export interface ConnectionSlot {
  label: string;
  registry: string; // registry connection id or app_name
  item_id: string;  // registry item id (matched against metadata.registry_item_id)
}

export interface ConnectionsSetupProps {
  slots: Record<string, ConnectionSlot>;
  onComplete: (connections: Record<string, string>) => void; // slotId → connection_id
}
```

## Reference: Phase State Machine (per slot)

```
loading → picker (existing matching connections found)
        → install (no matching connections)

picker → done (user selects a satisfied connection)
       → install (user clicks "Install fresh")

install → polling (after successful CONNECTION_CREATE)

polling → done (connection.status === "active")
        → auth-oauth (timeout/error + supportsOAuth)
        → auth-token (timeout/error + !supportsOAuth)

auth-oauth → polling (after authenticateMcp success + update trigger)
auth-token → polling (after token save + update trigger)

done → picker (user clicks [change])
     → install (no existing connections when [change] clicked)
```

---

## Task 1: Add query keys for registry item and connection polling

**Files:**
- Modify: `apps/mesh/src/web/lib/query-keys.ts`

**Step 1: Read the file**

Open `apps/mesh/src/web/lib/query-keys.ts` and find the `KEYS` object.

**Step 2: Add two new keys**

Add after the `isMCPAuthenticated` key:

```typescript
  registryItem: (registryId: string, itemId: string) =>
    ["registry-item", registryId, itemId] as const,

  connectionPoll: (connectionId: string) =>
    ["connection-poll", connectionId] as const,
```

**Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/lib/query-keys.ts
git commit -m "feat(connections-setup): add registry-item and connection-poll query keys"
```

---

## Task 2: Pure slot resolution logic + test

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-resolution.ts`
- Create: `apps/mesh/src/web/components/connections-setup/slot-resolution.test.ts`

**Step 1: Write the failing test**

Create `apps/mesh/src/web/components/connections-setup/slot-resolution.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { resolveInitialPhase } from "./slot-resolution";

function makeConn(
  overrides: Partial<ConnectionEntity> & { metadata?: Record<string, unknown> },
): ConnectionEntity {
  return {
    id: "conn_test",
    title: "Test",
    status: "inactive",
    connection_type: "HTTP",
    connection_url: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    tools: null,
    bindings: null,
    organization_id: "org_1",
    created_by: "user_1",
    updated_by: "user_1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as ConnectionEntity;
}

describe("resolveInitialPhase", () => {
  it("returns 'install' when no matching connections exist", () => {
    const connections: ConnectionEntity[] = [
      makeConn({ metadata: { registry_item_id: "other-item" } }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("install");
  });

  it("returns 'done' when a matching active connection exists", () => {
    const connections: ConnectionEntity[] = [
      makeConn({
        id: "conn_active",
        status: "active",
        metadata: { registry_item_id: "my-item" },
      }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("done");
  });

  it("returns 'picker' when matching connections exist but none are active", () => {
    const connections: ConnectionEntity[] = [
      makeConn({
        id: "conn_inactive",
        status: "inactive",
        metadata: { registry_item_id: "my-item" },
      }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("picker");
  });

  it("returns 'done' for first active match when multiple exist", () => {
    const connections: ConnectionEntity[] = [
      makeConn({ status: "inactive", metadata: { registry_item_id: "my-item" } }),
      makeConn({ id: "conn_2", status: "active", metadata: { registry_item_id: "my-item" } }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("done");
  });
});

describe("findMatchingConnections", () => {
  it("filters connections by registry_item_id", () => {
    const connections: ConnectionEntity[] = [
      makeConn({ id: "conn_a", metadata: { registry_item_id: "item-1" } }),
      makeConn({ id: "conn_b", metadata: { registry_item_id: "item-2" } }),
      makeConn({ id: "conn_c", metadata: { registry_item_id: "item-1" } }),
    ];
    const { findMatchingConnections } = await import("./slot-resolution");
    const result = findMatchingConnections(connections, "item-1");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(["conn_a", "conn_c"]);
  });
});
```

**Step 2: Run test to confirm it fails**

```bash
bun test apps/mesh/src/web/components/connections-setup/slot-resolution.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create the implementation**

Create `apps/mesh/src/web/components/connections-setup/slot-resolution.ts`:

```typescript
import type { ConnectionEntity } from "@decocms/mesh-sdk";

export type SlotPhase =
  | "loading"
  | "picker"
  | "install"
  | "polling"
  | "auth-oauth"
  | "auth-token"
  | "done";

export function findMatchingConnections(
  connections: ConnectionEntity[],
  itemId: string,
): ConnectionEntity[] {
  return connections.filter(
    (c) =>
      (c.metadata as Record<string, unknown> | null)?.registry_item_id === itemId,
  );
}

export function resolveInitialPhase(
  connections: ConnectionEntity[],
  itemId: string,
): "done" | "picker" | "install" {
  const matches = findMatchingConnections(connections, itemId);
  if (matches.length === 0) return "install";
  const hasActive = matches.some((c) => c.status === "active");
  return hasActive ? "done" : "picker";
}
```

**Step 4: Run tests to confirm they pass**

```bash
bun test apps/mesh/src/web/components/connections-setup/slot-resolution.test.ts
```

Expected: PASS (4 tests).

**Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/
git commit -m "feat(connections-setup): add slot resolution pure logic with tests"
```

---

## Task 3: `use-slot-resolution.ts` hook

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/use-slot-resolution.ts`

**Step 1: Write the hook**

This hook combines the pure resolution logic with async registry item fetching.

Create `apps/mesh/src/web/components/connections-setup/use-slot-resolution.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import {
  useConnections,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import {
  callRegistryTool,
  extractItemsFromResponse,
  findListToolName,
} from "@/web/utils/registry-utils";
import { KEYS } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";
import {
  findMatchingConnections,
  resolveInitialPhase,
  type SlotPhase,
} from "./slot-resolution";

export interface ConnectionSlot {
  label: string;
  registry: string;
  item_id: string;
}

export interface SlotResolution {
  initialPhase: SlotPhase;
  registryItem: RegistryItem | null;
  matchingConnections: ConnectionEntity[];
  satisfiedConnection: ConnectionEntity | null;
  isLoading: boolean;
  registryError: string | null;
}

export function useSlotResolution(slot: ConnectionSlot): SlotResolution {
  const { org } = useProjectContext();
  const allConnections = useConnections();
  const registryConnections = useRegistryConnections(allConnections);

  const registryConn = registryConnections.find(
    (c) => c.id === slot.registry || c.app_name === slot.registry,
  );

  const { data: registryItem, isLoading: isLoadingItem } = useQuery({
    queryKey: KEYS.registryItem(slot.registry, slot.item_id),
    queryFn: async (): Promise<RegistryItem | null> => {
      if (!registryConn) return null;
      const listTool = findListToolName(registryConn.tools);
      if (!listTool) return null;
      const result = await callRegistryTool<unknown>(
        registryConn.id,
        org.id,
        listTool,
        { where: { id: slot.item_id } },
      );
      const items = extractItemsFromResponse<RegistryItem>(result);
      return items[0] ?? null;
    },
    enabled: Boolean(registryConn && org),
    staleTime: 60 * 60 * 1000,
  });

  const connections = allConnections ?? [];
  const matchingConnections = findMatchingConnections(connections, slot.item_id);
  const satisfiedConnection =
    matchingConnections.find((c) => c.status === "active") ?? null;

  if (!allConnections || isLoadingItem) {
    return {
      initialPhase: "loading",
      registryItem: null,
      matchingConnections: [],
      satisfiedConnection: null,
      isLoading: true,
      registryError: null,
    };
  }

  const registryError =
    !isLoadingItem && !registryItem ? "Registry item not found." : null;

  const initialPhase = resolveInitialPhase(connections, slot.item_id);

  return {
    initialPhase,
    registryItem: registryItem ?? null,
    matchingConnections,
    satisfiedConnection,
    isLoading: false,
    registryError,
  };
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/use-slot-resolution.ts
git commit -m "feat(connections-setup): add use-slot-resolution hook"
```

---

## Task 4: `use-connection-poller.ts` hook

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/use-connection-poller.ts`

**Step 1: Write the hook**

Polls `COLLECTION_CONNECTIONS_GET` every 2s until `status === "active"` or `status === "error"`. Stops after 15s (timeout).

Create `apps/mesh/src/web/components/connections-setup/use-connection-poller.ts`:

```typescript
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createMCPClient,
  SELF_MCP_ALIAS_ID,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15000;

export interface ConnectionPollerResult {
  connection: ConnectionEntity | null;
  isActive: boolean;
  isTimedOut: boolean;
  isPolling: boolean;
}

export function useConnectionPoller(
  connectionId: string | null,
): ConnectionPollerResult {
  const { org } = useProjectContext();
  const startTimeRef = useRef<number>(0);

  if (connectionId && startTimeRef.current === 0) {
    startTimeRef.current = Date.now();
  }
  if (!connectionId) {
    startTimeRef.current = 0;
  }

  const { data: connection } = useQuery({
    queryKey: KEYS.connectionPoll(connectionId ?? ""),
    queryFn: async (): Promise<ConnectionEntity | null> => {
      if (!connectionId) return null;
      const client = await createMCPClient({
        connectionId: SELF_MCP_ALIAS_ID,
        orgId: org.id,
      });
      try {
        const result = (await client.callTool({
          name: "COLLECTION_CONNECTIONS_GET",
          arguments: { id: connectionId },
        })) as { structuredContent?: ConnectionEntity } | ConnectionEntity;
        return (
          (result as { structuredContent?: ConnectionEntity }).structuredContent ??
          (result as ConnectionEntity)
        );
      } finally {
        await client.close().catch(console.error);
      }
    },
    refetchInterval: (query) => {
      const conn = query.state.data;
      if (!connectionId) return false;
      if (conn?.status === "active" || conn?.status === "error") return false;
      if (Date.now() - startTimeRef.current > POLL_TIMEOUT_MS) return false;
      return POLL_INTERVAL_MS;
    },
    enabled: Boolean(connectionId && org),
    staleTime: 0,
  });

  const isTimedOut =
    Boolean(connectionId) &&
    startTimeRef.current > 0 &&
    Date.now() - startTimeRef.current > POLL_TIMEOUT_MS &&
    connection?.status !== "active";

  return {
    connection: connection ?? null,
    isActive: connection?.status === "active",
    isTimedOut,
    isPolling:
      Boolean(connectionId) &&
      connection?.status !== "active" &&
      connection?.status !== "error" &&
      !isTimedOut,
  };
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/use-connection-poller.ts
git commit -m "feat(connections-setup): add use-connection-poller hook"
```

---

## Task 5: `slot-done.tsx` — collapsed done state

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-done.tsx`

**Step 1: Write the component**

Create `apps/mesh/src/web/components/connections-setup/slot-done.tsx`:

```typescript
import { CheckCircle, ChevronDown } from "lucide-react";
import { Button } from "@deco/ui/components/button.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";

interface SlotDoneProps {
  label: string;
  connection: ConnectionEntity;
  onReset: () => void;
}

export function SlotDone({ label, connection, onReset }: SlotDoneProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-4 py-3">
      <CheckCircle className="size-4 shrink-0 text-success" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground truncate">{connection.title}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onReset} className="gap-1 shrink-0">
        Change <ChevronDown className="size-3" />
      </Button>
    </div>
  );
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/slot-done.tsx
git commit -m "feat(connections-setup): add slot-done component"
```

---

## Task 6: `slot-install-form.tsx` — install phase

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-install-form.tsx`

**Step 1: Write the component**

Pre-fills a connection form from the registry item via `extractConnectionData`. On submit creates the connection.

Create `apps/mesh/src/web/components/connections-setup/slot-install-form.tsx`:

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import type { RegistryItem } from "@/web/components/store/types";

const installSchema = z.object({
  title: z.string().min(1, "Name is required"),
});

type InstallFormData = z.infer<typeof installSchema>;

interface SlotInstallFormProps {
  registryItem: RegistryItem;
  onInstalled: (connectionId: string) => void;
}

export function SlotInstallForm({
  registryItem,
  onInstalled,
}: SlotInstallFormProps) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();

  const connectionData = extractConnectionData(
    registryItem,
    org.id,
    session?.user?.id ?? "system",
  );

  const form = useForm<InstallFormData>({
    resolver: zodResolver(installSchema),
    defaultValues: { title: connectionData.title ?? "" },
  });

  const handleSubmit = async (data: InstallFormData) => {
    const payload: ConnectionEntity = {
      ...(connectionData as ConnectionEntity),
      title: data.title,
    };
    await actions.create.mutateAsync(payload);
    onInstalled(connectionData.id);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Connection name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. OpenAI" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={actions.create.isPending} className="w-full">
          {actions.create.isPending ? "Installing..." : "Install"}
        </Button>
      </form>
    </Form>
  );
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/slot-install-form.tsx
git commit -m "feat(connections-setup): add slot-install-form component"
```

---

## Task 7: `slot-auth-oauth.tsx` — OAuth authorize phase

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-auth-oauth.tsx`

**Step 1: Write the component**

Mirrors `handleAuthenticate` from `apps/mesh/src/web/components/details/connection/index.tsx:340-409`.

Create `apps/mesh/src/web/components/connections-setup/slot-auth-oauth.tsx`:

```typescript
import { useState } from "react";
import { toast } from "sonner";
import {
  authenticateMcp,
  useConnectionActions,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";

interface SlotAuthOAuthProps {
  connectionId: string;
  providerName: string;
  onAuthed: () => void;
}

export function SlotAuthOAuth({
  connectionId,
  providerName,
  onAuthed,
}: SlotAuthOAuthProps) {
  const [isPending, setIsPending] = useState(false);
  const actions = useConnectionActions();
  const queryClient = useQueryClient();
  const mcpProxyUrl = new URL(`/mcp/${connectionId}`, window.location.origin);

  const handleAuthorize = async () => {
    setIsPending(true);
    try {
      const { token, tokenInfo, error } = await authenticateMcp({ connectionId });

      if (error || !token) {
        toast.error(`Authorization failed: ${error ?? "Unknown error"}`);
        return;
      }

      if (tokenInfo) {
        const response = await fetch(`/api/connections/${connectionId}/oauth-token`, {
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
        });
        if (!response.ok) {
          await actions.update.mutateAsync({
            id: connectionId,
            data: { connection_token: token },
          });
        } else {
          // Trigger tool re-discovery
          await actions.update.mutateAsync({ id: connectionId, data: {} });
        }
      } else {
        await actions.update.mutateAsync({
          id: connectionId,
          data: { connection_token: token },
        });
      }

      await queryClient.invalidateQueries({
        queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
      });

      onAuthed();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Authorize Mesh to access {providerName} on your behalf.
      </p>
      <Button onClick={handleAuthorize} disabled={isPending} className="w-full">
        {isPending ? "Authorizing..." : `Authorize with ${providerName}`}
      </Button>
    </div>
  );
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/slot-auth-oauth.tsx
git commit -m "feat(connections-setup): add slot-auth-oauth component"
```

---

## Task 8: `slot-auth-token.tsx` — token input phase

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-auth-token.tsx`

**Step 1: Write the component**

Create `apps/mesh/src/web/components/connections-setup/slot-auth-token.tsx`:

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useConnectionActions } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";

const tokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

type TokenFormData = z.infer<typeof tokenSchema>;

interface SlotAuthTokenProps {
  connectionId: string;
  onAuthed: () => void;
}

export function SlotAuthToken({ connectionId, onAuthed }: SlotAuthTokenProps) {
  const actions = useConnectionActions();

  const form = useForm<TokenFormData>({
    resolver: zodResolver(tokenSchema),
    defaultValues: { token: "" },
  });

  const handleSubmit = async (data: TokenFormData) => {
    await actions.update.mutateAsync({
      id: connectionId,
      data: { connection_token: data.token },
    });
    // Trigger tool re-discovery
    await actions.update.mutateAsync({ id: connectionId, data: {} });
    onAuthed();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="token"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API Token</FormLabel>
              <FormControl>
                <Input type="password" placeholder="sk-..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={actions.update.isPending} className="w-full">
          {actions.update.isPending ? "Saving..." : "Save token"}
        </Button>
      </form>
    </Form>
  );
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/slot-auth-token.tsx
git commit -m "feat(connections-setup): add slot-auth-token component"
```

---

## Task 9: `slot-card.tsx` — full phase state machine

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/slot-card.tsx`

This is the main orchestrator. It owns the per-slot phase state and transitions between all phases.

**Step 1: Write the component**

Create `apps/mesh/src/web/components/connections-setup/slot-card.tsx`:

```typescript
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { isConnectionAuthenticated } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { useSlotResolution, type ConnectionSlot } from "./use-slot-resolution";
import { useConnectionPoller } from "./use-connection-poller";
import { findMatchingConnections, type SlotPhase } from "./slot-resolution";
import { SlotDone } from "./slot-done";
import { SlotInstallForm } from "./slot-install-form";
import { SlotAuthOAuth } from "./slot-auth-oauth";
import { SlotAuthToken } from "./slot-auth-token";
import type { ConnectionEntity } from "@decocms/mesh-sdk";

interface SlotCardProps {
  slot: ConnectionSlot;
  onComplete: (connectionId: string) => void;
}

export function SlotCard({ slot, onComplete }: SlotCardProps) {
  const resolution = useSlotResolution(slot);
  const [phase, setPhase] = useState<SlotPhase | null>(null);
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<ConnectionEntity | null>(null);

  const poller = useConnectionPoller(pollingConnectionId);

  // Derive effective phase: explicit override takes priority, else from resolution
  const effectivePhase: SlotPhase = phase ?? resolution.initialPhase;

  // React to poller becoming active
  if (pollingConnectionId && poller.isActive && poller.connection) {
    setPollingConnectionId(null);
    setSelectedConnection(poller.connection);
    setPhase("done");
    onComplete(poller.connection.id);
  }

  // React to poller timeout/error — determine auth type needed
  if (
    pollingConnectionId &&
    (poller.isTimedOut || poller.connection?.status === "error")
  ) {
    const connectionId = pollingConnectionId;
    setPollingConnectionId(null);

    // Async: check auth status to determine next phase
    const url = new URL(`/mcp/${connectionId}`, window.location.origin).href;
    isConnectionAuthenticated({ url, token: null }).then((authStatus) => {
      if (authStatus.supportsOAuth) {
        setPhase("auth-oauth");
      } else {
        setPhase("auth-token");
      }
    });
  }

  const handleInstalled = (connectionId: string) => {
    setPollingConnectionId(connectionId);
    setPhase("polling");
  };

  const handleAuthed = () => {
    // Re-enter polling after auth — poller will reset via connectionId change
    const id = pollingConnectionId ?? selectedConnection?.id ?? null;
    if (id) {
      setPollingConnectionId(id);
      setPhase("polling");
    }
  };

  const handleReset = () => {
    const hasExisting = resolution.matchingConnections.length > 0;
    setPhase(hasExisting ? "picker" : "install");
    setSelectedConnection(null);
    setPollingConnectionId(null);
    onComplete(""); // signal slot is no longer complete
  };

  const resolvedConnection =
    selectedConnection ??
    resolution.satisfiedConnection ??
    null;

  if (effectivePhase === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{slot.label}</p>
      </div>
    );
  }

  if (resolution.registryError) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertCircle className="size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-medium">{slot.label}</p>
          <p className="text-xs text-muted-foreground">{resolution.registryError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4 space-y-3">
      <p className="text-sm font-medium text-foreground">{slot.label}</p>

      {effectivePhase === "done" && resolvedConnection && (
        <SlotDone
          label={slot.label}
          connection={resolvedConnection}
          onReset={handleReset}
        />
      )}

      {effectivePhase === "picker" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Already installed:</p>
          <div className="space-y-1">
            {resolution.matchingConnections.map((conn) => (
              <button
                key={conn.id}
                type="button"
                onClick={() => {
                  if (conn.status === "active") {
                    setSelectedConnection(conn);
                    setPhase("done");
                    onComplete(conn.id);
                  } else {
                    setSelectedConnection(conn);
                    setPollingConnectionId(conn.id);
                    setPhase("polling");
                  }
                }}
                className="w-full flex items-center justify-between rounded border px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <span>{conn.title}</span>
                <span className="text-xs text-muted-foreground">{conn.status}</span>
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setPhase("install")}
          >
            Install fresh
          </Button>
        </div>
      )}

      {effectivePhase === "install" && resolution.registryItem && (
        <SlotInstallForm
          registryItem={resolution.registryItem}
          onInstalled={handleInstalled}
        />
      )}

      {effectivePhase === "polling" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Connecting...
        </div>
      )}

      {effectivePhase === "auth-oauth" && selectedConnection && (
        <SlotAuthOAuth
          connectionId={selectedConnection.id}
          providerName={resolution.registryItem?.title ?? slot.label}
          onAuthed={handleAuthed}
        />
      )}

      {effectivePhase === "auth-token" && selectedConnection && (
        <SlotAuthToken
          connectionId={selectedConnection.id}
          onAuthed={handleAuthed}
        />
      )}
    </div>
  );
}
```

> **Note:** The `onComplete("")` call in `handleReset` is a sentinel to signal the slot is no longer done. `connections-setup.tsx` will filter out empty strings when checking completion.

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/slot-card.tsx
git commit -m "feat(connections-setup): add slot-card state machine component"
```

---

## Task 10: `connections-setup.tsx` — root component

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/connections-setup.tsx`

**Step 1: Write the component**

Create `apps/mesh/src/web/components/connections-setup/connections-setup.tsx`:

```typescript
import { useState } from "react";
import { SlotCard } from "./slot-card";
import type { ConnectionSlot } from "./use-slot-resolution";

export interface ConnectionsSetupProps {
  slots: Record<string, ConnectionSlot>;
  onComplete: (connections: Record<string, string>) => void;
}

export function ConnectionsSetup({ slots, onComplete }: ConnectionsSetupProps) {
  const [completed, setCompleted] = useState<Record<string, string>>({});

  const handleSlotComplete = (slotId: string, connectionId: string) => {
    const next = { ...completed };
    if (connectionId === "") {
      delete next[slotId];
    } else {
      next[slotId] = connectionId;
    }
    setCompleted(next);

    const slotIds = Object.keys(slots);
    const allDone = slotIds.every((id) => next[id]);
    if (allDone) {
      onComplete(next);
    }
  };

  return (
    <div className="space-y-3">
      {Object.entries(slots).map(([slotId, slot]) => (
        <SlotCard
          key={slotId}
          slot={slot}
          onComplete={(connectionId) => handleSlotComplete(slotId, connectionId)}
        />
      ))}
    </div>
  );
}
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/connections-setup.tsx
git commit -m "feat(connections-setup): add root connections-setup component"
```

---

## Task 11: `index.ts` barrel export

**Files:**
- Create: `apps/mesh/src/web/components/connections-setup/index.ts`

**Step 1: Write the barrel**

Create `apps/mesh/src/web/components/connections-setup/index.ts`:

```typescript
export { ConnectionsSetup } from "./connections-setup";
export type { ConnectionsSetupProps } from "./connections-setup";
export type { ConnectionSlot } from "./use-slot-resolution";
```

**Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/connections-setup/index.ts
git commit -m "feat(connections-setup): add barrel export"
```

---

## Task 12: Verify full implementation

**Step 1: Run all tests**

```bash
bun test apps/mesh/src/web/components/connections-setup/
```

Expected: PASS (slot-resolution tests).

**Step 2: Type-check**

```bash
bun run check
```

Expected: no errors in the new files.

**Step 3: Lint**

```bash
bun run lint
```

Fix any reported issues (kebab-case filenames, query key constants, no useEffect).

**Step 4: Format**

```bash
bun run fmt
```

---

## TODO (deferred)

- **CONFIG phase**: For MCPs with a `configuration_state` schema (configurable MCPs), add a config form phase after AUTH. Reuse `MCPConfigurationForm` from `apps/mesh/src/web/components/details/connection/settings-tab/mcp-configuration-form.tsx`. Trigger this phase when `isActive && connection.configuration_state !== null && configFormNotYetSubmitted`.

- **PICKER satisfied-connection preselection**: When the DONE state is entered from a PICKER selection of an already-active connection, `SlotDone` should show that connection without going through polling.
