# Home Next-Actions via MCP Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pre-seeded `thrd_welcome_<agentId>` threads and the sidebar's "Up next" view with a home-page next-actions row driven by MCP prompts (plus storefront-manager's existing dialog actions as dialog-cards).

**Architecture:** Each existing Studio Pack checklist item becomes a real MCP prompt registered on the SELF connection's prompt list, whitelisted per-agent via `selected_prompts`. A new `/api/:org/home-next-actions` endpoint returns the still-incomplete items as either `prompts` (open new thread with prompt autosent) or `dialogs` (open UI modal). The home page renders cards below `Chat.Input`; click handlers reuse `PromptArgsDialog`, `getPrompt`, `createMentionDoc`, `derivePartsFromTiptapDoc`, `writeStoredAutosend`, and `createNewTask` from existing modules — only a small `useStartThreadFromPrompt` hook is new.

**Tech Stack:** TypeScript, Hono (server), React 19 + TanStack Query (client), Bun test runner, MCP TypeScript SDK.

**Strategy:** Add the new surface alongside the old one first (additive, both work), then switch defaults and delete the old pieces in a single pass. Each commit is independently shippable.

**Spec:** `docs/superpowers/specs/2026-05-26-home-next-actions-prompts-design.md`

---

## Phase A — Add new pieces (additive, old surface still works)

### Task 1: Add Studio Pack onboarding prompts module

**Files:**
- Create: `apps/mesh/src/tools/guides/studio-pack-onboarding.ts`
- Modify: `apps/mesh/src/tools/guides/index.ts`

- [ ] **Step 1: Create the prompts file**

Create `apps/mesh/src/tools/guides/studio-pack-onboarding.ts`:

```typescript
import type { GuidePrompt } from "./index";

/**
 * MCP prompts that back the home-page "next actions" cards. Each prompt
 * corresponds to a Studio Pack checklist item; the agent's `selected_prompts`
 * whitelists only its own entries so a `/promptName` mention in chat shows
 * the relevant set per agent.
 *
 * The text body is what gets autosent as the first user message when the
 * user clicks the corresponding home card. For items that today have no
 * autosend prompt (the agent's welcome message did the work), we author a
 * short trigger sentence and rely on the agent's instructions to drive the
 * conversation.
 */
export const prompts: GuidePrompt[] = [
  // Brand Manager
  {
    name: "brand-manager-set-up",
    title: "Set up your brand",
    description: "Create your brand context — extract from a domain or set up manually.",
    text: "Help me set up my brand context. Start by asking for my website URL so you can extract logo, colors, fonts, and overview automatically — or guide me through manual setup if I don't have a public site.",
  },
  {
    name: "brand-manager-complete-profile",
    title: "Complete your brand profile",
    description: "Fill in logo, colors, and fonts on your existing brand.",
    text: "Help me fill in the rest of my brand profile — logo, colors, and fonts. Check what's already there and ask me about the missing pieces.",
  },
  {
    name: "brand-manager-create-landing-page",
    title: "Create a landing page",
    description: "Author a brand-aligned landing page using your active brand context.",
    text: "Build me a landing page now using my brand. I'll iterate after I see it.",
  },
  // Store Manager
  {
    name: "store-manager-browse-store",
    title: "Browse the Deco Store",
    description: "Explore what's in the Store and Community Registry and get MCP recommendations.",
    text: "Show me what's in the Deco Store and the Community Registry. Ask me what problem I'm trying to solve and recommend a few MCPs that fit.",
  },
];
```

- [ ] **Step 2: Wire prompts into the aggregator**

Modify `apps/mesh/src/tools/guides/index.ts`:

```typescript
import * as agents from "./agents";
import * as aiProviders from "./ai-providers";
import * as automations from "./automations";
import * as connections from "./connections";
import * as platform from "./platform";
import * as store from "./store";
import * as studioPackOnboarding from "./studio-pack-onboarding";
import * as virtualTools from "./virtual-tools";

export interface GuidePrompt { /* unchanged */ }
export interface GuideResource { /* unchanged */ }

export function getPrompts(): GuidePrompt[] {
  return [
    ...agents.prompts,
    ...connections.prompts,
    ...store.prompts,
    ...automations.prompts,
    ...aiProviders.prompts,
    ...virtualTools.prompts,
    ...studioPackOnboarding.prompts,
  ];
}

export function getResources(): GuideResource[] { /* unchanged */ }
```

- [ ] **Step 3: Verify the prompts register at server boot**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/tools/guides/studio-pack-onboarding.ts apps/mesh/src/tools/guides/index.ts
git commit -m "feat(studio-pack): register onboarding prompts on SELF connection"
```

---

### Task 2: Declare `selectedPrompts` on each studio-pack agent

**Files:**
- Modify: `apps/mesh/src/tools/virtual/studio-pack/brand-manager.ts`
- Modify: `apps/mesh/src/tools/virtual/studio-pack/store-manager.ts`
- Modify: `apps/mesh/src/tools/virtual/studio-pack/agent-manager.ts`
- Modify: `apps/mesh/src/tools/virtual/studio-pack/automation-manager.ts`
- Modify: `apps/mesh/src/tools/virtual/studio-pack/connection-manager.ts`

This task only **adds** a new `selectedPrompts` field to each agent. `installStudioPack` will start consuming it in Task 4. Adding the field now keeps the change separable.

- [ ] **Step 1: Add `selectedPrompts` to Brand Manager**

In `apps/mesh/src/tools/virtual/studio-pack/brand-manager.ts`, add the field next to `selectedTools` inside `brandManagerAgent`:

```typescript
  selectedPrompts: [
    "brand-manager-set-up",
    "brand-manager-complete-profile",
    "brand-manager-create-landing-page",
  ] as readonly string[],
```

- [ ] **Step 2: Add `selectedPrompts` to Store Manager**

In `apps/mesh/src/tools/virtual/studio-pack/store-manager.ts`, add inside `storeManagerAgent`:

```typescript
  selectedPrompts: ["store-manager-browse-store"] as readonly string[],
```

- [ ] **Step 3: Add empty `selectedPrompts` to Agent / Automation / Connection Manager**

These three agents have no checklist items today, so they whitelist nothing:

In `apps/mesh/src/tools/virtual/studio-pack/agent-manager.ts`, `automation-manager.ts`, and `connection-manager.ts`, add to each agent:

```typescript
  selectedPrompts: [] as readonly string[],
```

- [ ] **Step 4: Run typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/tools/virtual/studio-pack/{brand,store,agent,automation,connection}-manager.ts
git commit -m "feat(studio-pack): declare per-agent selectedPrompts whitelists"
```

---

### Task 3: Surface `selectedPrompts` in `installStudioPack` writes

**Files:**
- Modify: `apps/mesh/src/tools/virtual/studio-pack/index.ts:99-122`

- [ ] **Step 1: Read the current install loop**

Open `apps/mesh/src/tools/virtual/studio-pack/index.ts`. Inside `installStudioPack`, the inner `.map` currently writes `selected_prompts: null`. We'll wire it up to the agent's `selectedPrompts` field instead.

- [ ] **Step 2: Update the write**

Change the `connections` mapping inside `virtualMcpStorage.create(...)` to:

```typescript
connections: connectionIds.map((connection_id) => ({
  connection_id,
  selected_tools: agent.selectedTools ? [...agent.selectedTools] : null,
  selected_resources: null,
  // An empty array means "no prompts" (correct for agents without
  // onboarding items). `null` would mean "all prompts allowed" — which
  // we never want post-whitelist. Every studio-pack agent declares
  // `selectedPrompts` (Task 2), so this never falls through to null.
  selected_prompts: agent.selectedPrompts
    ? [...agent.selectedPrompts]
    : null,
})),
```

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS — `selectedPrompts` is on every studio-pack agent (Task 2).

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/tools/virtual/studio-pack/index.ts
git commit -m "feat(studio-pack): write selected_prompts whitelist on install"
```

---

### Task 4: Add backfill step for existing orgs' `selected_prompts`

**Files:**
- Modify: `apps/mesh/src/auth/install-studio-pack-workflow.ts`

For orgs that already had studio-pack agents installed before this change, their `selected_prompts` is `null` (i.e., all prompts allowed). We add a step that, for each org, upgrades existing rows to the agent's whitelist.

- [ ] **Step 1: Add a backfill step function**

Add this function to `apps/mesh/src/auth/install-studio-pack-workflow.ts` above `installStudioPackWorkflowFn`:

```typescript
/**
 * Backfill `selected_prompts` on previously-installed studio-pack agents.
 * Pre-prompt-whitelist installs wrote `null` (all prompts allowed); now we
 * narrow each agent to its own checklist prompts.
 */
async function backfillSelectedPromptsStep(
  input: InstallStudioPackInput,
): Promise<void> {
  const database = getDb();
  const virtualMcpStorage = new VirtualMCPStorage(database.db);

  for (const agent of STUDIO_PACK_AGENTS) {
    const agentId = agent.getId(input.orgId);
    const existing = await virtualMcpStorage.findById(agentId, input.orgId);
    if (!existing) continue;

    // Empty array means "no prompts"; null means "all prompts allowed".
    // We always want the explicit array to win post-whitelist.
    const desired = agent.selectedPrompts
      ? [...agent.selectedPrompts]
      : null;

    // Skip the write if every connection already matches `desired`.
    const sameAsDesired = existing.connections.every((c) => {
      const current = c.selected_prompts;
      if (desired === null) return current === null;
      if (current === null) return false;
      if (current.length !== desired.length) return false;
      return current.every((p, i) => p === desired[i]);
    });
    if (sameAsDesired) continue;

    await virtualMcpStorage.update(agentId, input.orgId, {
      connections: existing.connections.map((c) => ({
        connection_id: c.connection_id,
        selected_tools: c.selected_tools,
        selected_resources: c.selected_resources,
        selected_prompts: desired,
      })),
    });
  }
}
```

- [ ] **Step 2: Call the backfill from the workflow**

Update `installStudioPackWorkflowFn`:

```typescript
async function installStudioPackWorkflowFn(
  input: InstallStudioPackInput,
): Promise<void> {
  await DBOS.runStep(() => installStudioPackStep(input), {
    name: "installStudioPack",
  });
  await DBOS.runStep(() => createWelcomeThreadsStep(input), {
    name: "createWelcomeThreads",
  });
  await DBOS.runStep(() => backfillSelectedPromptsStep(input), {
    name: "backfillSelectedPrompts",
  });
}
```

(Note: `createWelcomeThreadsStep` is still here — we delete it in Phase B Task 14.)

- [ ] **Step 3: Verify storage update method signature**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If `virtualMcpStorage.update(...)`'s signature differs, adjust to the actual signature (see `apps/mesh/src/storage/virtual.ts:~370–440`); the per-row shape `{ connection_id, selected_tools, selected_resources, selected_prompts }` is the one written in the existing `update` body.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/auth/install-studio-pack-workflow.ts
git commit -m "feat(studio-pack): backfill selected_prompts on existing installs"
```

---

### Task 5: Add `home-next-actions` server route (alongside old)

**Files:**
- Create: `apps/mesh/src/api/routes/home-next-actions.ts`
- Modify: `apps/mesh/src/api/routes/org-scoped.ts`

The new endpoint runs alongside the old `/studio-pack-checklists`. We keep both during the transition; old code paths still work until Phase B.

- [ ] **Step 1: Look up prompt metadata by name**

The endpoint needs to attach `arguments` + `description` + `title` from the registered prompt for each `promptName`. We use `getPrompts()` from `apps/mesh/src/tools/guides`.

- [ ] **Step 2: Create the route file**

Create `apps/mesh/src/api/routes/home-next-actions.ts`:

```typescript
/**
 * Home Next-Actions
 *
 * `GET /api/:org/home-next-actions`
 *
 * Returns the still-incomplete onboarding actions for the `/$org` home
 * page. Two shapes coexist:
 * - `prompts`: each opens a new thread with the named agent and autosends
 *   the resolved MCP prompt as the first user message.
 * - `dialogs`: each opens a client-side modal (storefront / GitHub / site
 *   monitoring). No thread is created.
 *
 * Server-side `isCompleted` filters out finished items so the home stays
 * pared down as the user makes progress.
 */

import { Hono } from "hono";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "@/core/mesh-context";
import { getPrompts } from "@/tools/guides";
import {
  STUDIO_PACK_AGENTS,
  resolveStorefrontManagerChecklist,
  resolveStudioPackChecklist,
  storefrontManagerAgent,
} from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

type DialogKind =
  | "install-github-mcp"
  | "add-storefront"
  | "configure-github-automations"
  | "setup-site-monitoring"
  | "github-import";

interface PromptEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments: Prompt["arguments"];
}

interface DialogEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  label: string;
  kind: DialogKind;
}

function indexPromptsByName() {
  const all = getPrompts();
  const byName = new Map<string, (typeof all)[number]>();
  for (const p of all) byName.set(p.name, p);
  return byName;
}

export function createHomeNextActionsRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/home-next-actions", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const promptByName = indexPromptsByName();

    const [storefrontItems, perAgent] = await Promise.all([
      resolveStorefrontManagerChecklist({ orgId, ctx: mesh }),
      Promise.all(
        STUDIO_PACK_AGENTS.map(async (agent) => ({
          agent,
          items: await resolveStudioPackChecklist(agent, {
            orgId,
            ctx: mesh,
          }),
        })),
      ),
    ]);

    const prompts: PromptEntry[] = [];
    for (const { agent, items } of perAgent) {
      for (const item of items) {
        if (item.completed) continue;
        if (item.action.kind !== "open-agent-thread") continue;
        // Each studio-pack checklist item must have a corresponding prompt
        // name in studio-pack-onboarding.ts. Build the convention here.
        const promptName = `${agent.id}-${item.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")}`;
        const meta = promptByName.get(promptName);
        if (!meta) {
          // No prompt registered for this label yet — skip silently so the
          // home doesn't show a broken card.
          continue;
        }
        prompts.push({
          agentId: agent.getId(orgId),
          agentName: agent.title,
          agentIcon: agent.icon,
          promptName: meta.name,
          title: meta.title,
          description: meta.description,
          hasArguments: false,
          arguments: undefined,
        });
      }
    }

    const dialogs: DialogEntry[] = [];
    for (const item of storefrontItems) {
      if (item.completed) continue;
      if (item.action.kind === "open-agent-thread") continue;
      dialogs.push({
        agentId: storefrontManagerAgent.getId(orgId),
        agentName: storefrontManagerAgent.title,
        agentIcon: storefrontManagerAgent.icon,
        label: item.label,
        kind: item.action.kind,
      });
    }

    c.header("Cache-Control", "private, max-age=10");
    return c.json({ prompts, dialogs });
  });

  return app;
}
```

The `promptName` is built from `agent.id + item.label` slug. **The slug must match the prompt names registered in Task 1** (`brand-manager-set-up`, `brand-manager-complete-profile`, `brand-manager-create-landing-page`, `store-manager-browse-store`).

- [ ] **Step 3: Mount the new route**

In `apps/mesh/src/api/routes/org-scoped.ts`, add the import + mount alongside the existing studio-pack ones:

```typescript
import { createHomeNextActionsRoutes } from "./home-next-actions";
// …
  app.route("/", createHomeNextActionsRoutes());
```

Place the new `.route(...)` line right after `createStudioPackChecklistsRoutes()`.

- [ ] **Step 4: Sanity-check the slug convention**

Boot the server (`bun run --cwd=apps/mesh dev:server`) — server should start without errors. Manually hit `/api/<org>/home-next-actions` from a logged-in browser session and confirm at least one prompt entry appears for a fresh org (with a brand context not yet set). Verify the `promptName` matches one of the names from Task 1.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/api/routes/home-next-actions.ts apps/mesh/src/api/routes/org-scoped.ts
git commit -m "feat(api): add /home-next-actions endpoint"
```

---

### Task 6: Add the home-next-actions query key

**Files:**
- Modify: `apps/mesh/src/web/lib/query-keys.ts`

- [ ] **Step 1: Add the key**

In `apps/mesh/src/web/lib/query-keys.ts`, after the existing `studioPackChecklists` line:

```typescript
  // Home next-actions — prompts + dialog actions surfaced under Chat.Input.
  homeNextActions: (orgSlug: string) =>
    ["home-next-actions", orgSlug] as const,
```

Do NOT remove `studioPackChecklists` yet — Phase B does that.

- [ ] **Step 2: Commit**

```bash
git add apps/mesh/src/web/lib/query-keys.ts
git commit -m "feat(home): add homeNextActions query key"
```

---

### Task 7: Add `useHomeNextActions` hook

**Files:**
- Create: `apps/mesh/src/web/hooks/use-home-next-actions.ts`

- [ ] **Step 1: Create the hook**

Create `apps/mesh/src/web/hooks/use-home-next-actions.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { KEYS } from "@/web/lib/query-keys";

export type DialogKind =
  | "install-github-mcp"
  | "add-storefront"
  | "configure-github-automations"
  | "setup-site-monitoring"
  | "github-import";

export interface HomePromptEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments?: Prompt["arguments"];
}

export interface HomeDialogEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  label: string;
  kind: DialogKind;
}

interface HomeNextActionsResponse {
  prompts: HomePromptEntry[];
  dialogs: HomeDialogEntry[];
}

export function useHomeNextActions(orgSlug: string) {
  const query = useQuery({
    queryKey: KEYS.homeNextActions(orgSlug),
    queryFn: async (): Promise<HomeNextActionsResponse> => {
      const res = await fetch(`/api/${orgSlug}/home-next-actions`);
      if (!res.ok) throw new Error("Failed to load home next actions");
      return (await res.json()) as HomeNextActionsResponse;
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  return {
    isLoading: query.isLoading,
    prompts: query.data?.prompts ?? [],
    dialogs: query.data?.dialogs ?? [],
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/hooks/use-home-next-actions.ts
git commit -m "feat(home): add useHomeNextActions hook"
```

---

### Task 8: Add `useStartThreadFromPrompt` hook (TDD)

**Files:**
- Create: `apps/mesh/src/web/hooks/use-start-thread-from-prompt.tsx`
- Create: `apps/mesh/src/web/hooks/use-start-thread-from-prompt.test.tsx`

This hook owns the args-dialog state and the autosend/createNewTask handoff. It's the only meaningful new client-side logic, so it gets tests.

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/web/hooks/use-start-thread-from-prompt.test.tsx`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

// Mocked dependencies — we'll set these per test.
const mockGetPrompt = mock<
  (client: unknown, name: string, args?: Record<string, string>) => Promise<{
    messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
  }>
>();
const mockWriteStoredAutosend = mock<(...args: unknown[]) => unknown>();
const mockCreate = mock<(...args: unknown[]) => Promise<unknown>>();
const mockSetTaskId = mock<(id: string, vmcp?: string) => void>();

mock.module("@decocms/mesh-sdk", () => ({
  getPrompt: (...args: Parameters<typeof mockGetPrompt>) =>
    mockGetPrompt(...args),
  useMCPClient: () => ({ /* opaque MCP client */ } as unknown),
  useProjectContext: () => ({
    org: { id: "org-id", slug: "org-slug" },
    locator: "loc",
  }),
}));

mock.module("@/web/lib/autosend", () => ({
  writeStoredAutosend: (...args: unknown[]) => mockWriteStoredAutosend(...args),
}));

mock.module("@/web/layouts/shell-layout", () => ({
  usePanelActions: () => ({
    setTaskId: mockSetTaskId,
    createNewTask: async () => {},
  }),
}));

// Avoid needing a real thread-create hook; stub it to call mockCreate.
mock.module("@/web/components/chat/store/hooks", () => ({
  useThreadActions: () => ({ create: mockCreate, hide: () => {} }),
}));

import { useStartThreadFromPrompt } from "./use-start-thread-from-prompt";

const promptNoArgs: Prompt = {
  name: "brand-manager-set-up",
  description: "Set up your brand",
};

const promptWithArgs: Prompt = {
  name: "needs-input",
  description: "Needs input",
  arguments: [{ name: "url", required: true }],
};

beforeEach(() => {
  mockGetPrompt.mockReset();
  mockWriteStoredAutosend.mockReset();
  mockCreate.mockReset();
  mockSetTaskId.mockReset();
});

describe("useStartThreadFromPrompt", () => {
  it("for prompts with no arguments, resolves and autosends immediately", async () => {
    mockGetPrompt.mockResolvedValueOnce({
      messages: [
        { role: "user", content: { type: "text", text: "hello brand" } },
      ],
    });
    mockCreate.mockResolvedValueOnce({});

    const { result } = renderHook(() =>
      useStartThreadFromPrompt({ agentId: "vm-brand" }),
    );

    await act(async () => {
      await result.current.start(promptNoArgs);
    });

    expect(mockGetPrompt).toHaveBeenCalledTimes(1);
    expect(mockGetPrompt.mock.calls[0][1]).toBe("brand-manager-set-up");
    expect(mockWriteStoredAutosend).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockCreate.mock.calls[0][0] as {
      id: string;
      virtual_mcp_id: string;
    };
    expect(createArgs.virtual_mcp_id).toBe("vm-brand");
    expect(mockSetTaskId).toHaveBeenCalledWith(createArgs.id, "vm-brand");
  });

  it("for prompts with arguments, opens the args dialog and does NOT autosend until submitted", async () => {
    const { result } = renderHook(() =>
      useStartThreadFromPrompt({ agentId: "vm-brand" }),
    );

    await act(async () => {
      await result.current.start(promptWithArgs);
    });

    // Dialog is now open — neither getPrompt nor createNewTask was called.
    expect(mockGetPrompt).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.current.dialogPrompt?.name).toBe("needs-input");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/web/hooks/use-start-thread-from-prompt.test.tsx -v`
Expected: FAIL with "Cannot find module './use-start-thread-from-prompt'".

- [ ] **Step 3: Implement the hook**

Create `apps/mesh/src/web/hooks/use-start-thread-from-prompt.tsx`:

```tsx
/**
 * useStartThreadFromPrompt
 *
 * Starts a new thread on `agentId` and seeds it with an MCP prompt as the
 * first user message. Mirrors `ice-breakers.tsx`'s prompt-selection flow
 * (args dialog gating + getPrompt + mention chip), but writes to the
 * autosend buffer and creates a fresh thread instead of sending into the
 * current chat.
 *
 * Usage:
 *   const { start, dialog } = useStartThreadFromPrompt({ agentId });
 *   <NextActionCard onClick={() => start(prompt)} />
 *   {dialog}
 */

import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import {
  getPrompt,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "@/web/components/chat/dialog-prompt-arguments";
import { derivePartsFromTiptapDoc } from "@/web/components/chat/derive-parts";
import { createMentionDoc } from "@/web/components/chat/tiptap/mention/node";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { writeStoredAutosend } from "@/web/lib/autosend";

export interface UseStartThreadFromPromptResult {
  /** Trigger from a card click. Opens args dialog if needed. */
  start: (prompt: Prompt) => Promise<void>;
  /** Render this in your component to mount the args dialog. */
  dialog: ReactNode;
  /** Useful for tests / loading states. */
  dialogPrompt: Prompt | null;
}

export function useStartThreadFromPrompt({
  agentId,
}: {
  agentId: string;
}): UseStartThreadFromPromptResult {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: agentId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { create } = useThreadActions();
  const { setTaskId } = usePanelActions();
  const [dialogPrompt, setDialogPrompt] = useState<Prompt | null>(null);

  const loadAndStart = async (
    prompt: Prompt,
    args?: PromptArgumentValues,
  ) => {
    if (!client) {
      toast.error("MCP client not available");
      return;
    }
    try {
      const result = await getPrompt(client, prompt.name, args);
      const tiptapDoc = {
        type: "doc" as const,
        content: [
          {
            type: "paragraph",
            content: [
              createMentionDoc({
                id: prompt.name,
                name: stripToolNamespace(
                  prompt.name,
                  getGatewayClientId(prompt._meta),
                ),
                metadata: result.messages,
                char: "/",
                kind: "prompt",
                args,
              }),
            ],
          },
        ],
      };
      const parts = derivePartsFromTiptapDoc(tiptapDoc);

      const newId = crypto.randomUUID();
      writeStoredAutosend(sessionStorage, locator, newId, { parts });
      await create({ id: newId, virtual_mcp_id: agentId });
      setTaskId(newId, agentId);
    } catch (error) {
      console.error("[start-thread-from-prompt] failed", error);
      toast.error("Failed to start thread. Please try again.");
    }
  };

  const start = async (prompt: Prompt) => {
    if (prompt.arguments && prompt.arguments.length > 0) {
      setDialogPrompt(prompt);
      return;
    }
    await loadAndStart(prompt);
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!dialogPrompt) return;
    const prompt = dialogPrompt;
    setDialogPrompt(null);
    await loadAndStart(prompt, values);
  };

  const dialog = (
    <PromptArgsDialog
      prompt={dialogPrompt}
      setPrompt={(p) => setDialogPrompt(p)}
      onSubmit={handleDialogSubmit}
    />
  );

  return { start, dialog, dialogPrompt };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test apps/mesh/src/web/hooks/use-start-thread-from-prompt.test.tsx -v`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck the whole app**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/web/hooks/use-start-thread-from-prompt.tsx apps/mesh/src/web/hooks/use-start-thread-from-prompt.test.tsx
git commit -m "feat(home): add useStartThreadFromPrompt hook"
```

---

### Task 9: Add `NextActionsRow` home component

**Files:**
- Create: `apps/mesh/src/web/components/home/next-actions-row.tsx`

- [ ] **Step 1: Create the component**

Create `apps/mesh/src/web/components/home/next-actions-row.tsx`:

```tsx
/**
 * NextActionsRow
 *
 * Renders below `Chat.Input` on the /$org home page. Two card kinds:
 *   - Prompt cards → open a new thread with an agent and autosend a prompt.
 *   - Dialog cards → open a client-side modal (storefront / GitHub / site
 *     monitoring). No thread is created.
 *
 * Server filters out completed items so the row stays pared down as the
 * user makes progress.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useProjectContext } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AddStorefrontModal } from "@/web/components/add-storefront-modal";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { InstallGitHubMcpDialog } from "@/web/components/install-github-mcp-dialog";
import { SetupSiteMonitoringModal } from "@/web/components/setup-site-monitoring-modal";
import {
  type HomePromptEntry,
  type HomeDialogEntry,
  useHomeNextActions,
} from "@/web/hooks/use-home-next-actions";
import { useStartThreadFromPrompt } from "@/web/hooks/use-start-thread-from-prompt";
import { KEYS } from "@/web/lib/query-keys";

function PromptCard({
  entry,
  onClick,
}: {
  entry: HomePromptEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row flex w-72 shrink-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar
        icon={entry.agentIcon}
        name={entry.agentName}
        size="sm+"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="w-full truncate text-xs text-muted-foreground">
          {entry.agentName}
        </div>
        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
          {entry.title}
        </div>
      </div>
    </button>
  );
}

function DialogCard({
  entry,
  onClick,
}: {
  entry: HomeDialogEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row flex w-72 shrink-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar
        icon={entry.agentIcon}
        name={entry.agentName}
        size="sm+"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="w-full truncate text-xs text-muted-foreground">
          {entry.agentName}
        </div>
        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
          {entry.label}
        </div>
      </div>
    </button>
  );
}

function PromptCardRow({ entries }: { entries: HomePromptEntry[] }) {
  // Each agent's prompts get their own hook scope so the MCP client is
  // correctly keyed by virtual_mcp_id.
  const byAgent = new Map<string, HomePromptEntry[]>();
  for (const e of entries) {
    const existing = byAgent.get(e.agentId);
    if (existing) existing.push(e);
    else byAgent.set(e.agentId, [e]);
  }
  return (
    <>
      {Array.from(byAgent.entries()).map(([agentId, list]) => (
        <AgentPromptCardGroup key={agentId} agentId={agentId} entries={list} />
      ))}
    </>
  );
}

function AgentPromptCardGroup({
  agentId,
  entries,
}: {
  agentId: string;
  entries: HomePromptEntry[];
}) {
  const { start, dialog } = useStartThreadFromPrompt({ agentId });

  const handleClick = (entry: HomePromptEntry) => {
    // Reconstruct a minimal Prompt for the hook. The hook re-fetches the
    // resolved messages via getPrompt(client, name, args).
    const prompt: Prompt = {
      name: entry.promptName,
      description: entry.description,
      arguments: entry.arguments,
    };
    void start(prompt);
  };

  return (
    <>
      {entries.map((entry) => (
        <PromptCard
          key={entry.promptName}
          entry={entry}
          onClick={() => handleClick(entry)}
        />
      ))}
      {dialog}
    </>
  );
}

export function NextActionsRow() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const { isLoading, prompts, dialogs } = useHomeNextActions(org.slug);

  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [installGithubOpen, setInstallGithubOpen] = useState(false);
  const [addStorefrontOpen, setAddStorefrontOpen] = useState(false);
  const [siteMonitoringOpen, setSiteMonitoringOpen] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.homeNextActions(org.slug),
    });

  const handleDialogClick = (kind: HomeDialogEntry["kind"]) => {
    switch (kind) {
      case "github-import":
        setGithubPickerOpen(true);
        return;
      case "install-github-mcp":
        setInstallGithubOpen(true);
        return;
      case "add-storefront":
      case "configure-github-automations":
        setAddStorefrontOpen(true);
        return;
      case "setup-site-monitoring":
        setSiteMonitoringOpen(true);
        return;
    }
  };

  const isEmpty = !isLoading && prompts.length === 0 && dialogs.length === 0;
  if (isEmpty) return null;

  return (
    <>
      <div className="w-full max-w-[672px] mt-4">
        <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
          {isLoading
            ? Array.from({ length: 3 }, (_, i) => (
                <div
                  key={`skeleton-${i}`}
                  className="flex w-72 shrink-0 flex-col gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5"
                >
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
                </div>
              ))
            : (
                <>
                  <PromptCardRow entries={prompts} />
                  {dialogs.map((d) => (
                    <DialogCard
                      key={`${d.agentId}-${d.kind}`}
                      entry={d}
                      onClick={() => handleDialogClick(d.kind)}
                    />
                  ))}
                </>
              )}
        </div>
      </div>
      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={(open) => {
          setGithubPickerOpen(open);
          if (!open) invalidate();
        }}
      />
      <InstallGitHubMcpDialog
        open={installGithubOpen}
        onOpenChange={(open) => {
          setInstallGithubOpen(open);
          if (!open) invalidate();
        }}
      />
      <AddStorefrontModal
        open={addStorefrontOpen}
        onOpenChange={(open) => {
          setAddStorefrontOpen(open);
          if (!open) invalidate();
        }}
      />
      <SetupSiteMonitoringModal
        open={siteMonitoringOpen}
        onOpenChange={(open) => {
          setSiteMonitoringOpen(open);
          if (!open) invalidate();
        }}
      />
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/home/next-actions-row.tsx
git commit -m "feat(home): add NextActionsRow component"
```

---

### Task 10: Render `NextActionsRow` under `Chat.Input` on the home page

**Files:**
- Modify: `apps/mesh/src/web/layouts/home-page/index.tsx`

- [ ] **Step 1: Import the component**

Add to the imports in `apps/mesh/src/web/layouts/home-page/index.tsx`:

```typescript
import { NextActionsRow } from "@/web/components/home/next-actions-row";
```

- [ ] **Step 2: Render in the mobile branch**

In the mobile JSX (the `isMobile` branch), add `<NextActionsRow />` right after `<Chat.Input … />`:

```tsx
<div className="relative w-full flex flex-col gap-4 pb-8 px-4">
  <Chat.Input showConnectionsBanner />
  <NextActionsRow />
  {isDecoUser && (
    <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
  )}
</div>
```

- [ ] **Step 3: Render in the desktop branch**

In the desktop JSX, add `<NextActionsRow />` after the `<Chat.Input … />` inside the centered max-w-[672px] container:

```tsx
<div className="relative w-full">
  <Capybara />
  <Chat.Input showConnectionsBanner />
</div>
<NextActionsRow />
```

- [ ] **Step 4: Smoke test in the dev server**

Run the dev server (`bun run dev`), log in to a fresh org, navigate to `/<org>`. Confirm next-action cards render under the chat input. Click "Set up your brand" → land on a new thread, agent's first message arrives. Refresh → card disappears for items already completed.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/layouts/home-page/index.tsx
git commit -m "feat(home): render NextActionsRow below chat input"
```

---

## Phase B — Remove old surface

### Task 11: Remove sidebar "Up next" view-mode

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`

- [ ] **Step 1: Strip the suggestions / checklists imports**

In `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`:

Remove these imports:
```typescript
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { InstallGitHubMcpDialog } from "@/web/components/install-github-mcp-dialog";
import { AddStorefrontModal } from "@/web/components/add-storefront-modal";
import { SetupSiteMonitoringModal } from "@/web/components/setup-site-monitoring-modal";
import { writeStoredAutosend } from "@/web/lib/autosend";
import {
  type SuggestedAction,
  useSuggestedActions,
} from "@/web/layouts/tasks-panel/use-suggested-actions";
import {
  type ChecklistItemAction,
  type StudioPackChecklist,
  type StudioPackChecklistItem,
  useStudioPackChecklists,
} from "@/web/layouts/tasks-panel/use-studio-pack-checklists";
```

Also remove `KEYS` import line if `studioPackChecklists` was its only use — keep `KEYS` if other usages remain.

- [ ] **Step 2: Remove view-mode state + dropdown**

Remove these state lines:
```typescript
const [viewMode, setViewMode] = useState<ViewMode>("suggestions");
```

Remove the `VIEW_MODE_LABELS` constant and the `type ViewMode = ...` type.

In the JSX, replace the entire `<DropdownMenu>` block that selects `viewMode` (the one with `VIEW_MODE_LABELS`) with the static heading you want, or remove it entirely if a heading isn't needed. The simplest replacement: nothing — drop the dropdown trigger but keep the `flex` row for the right-side toolbar icons. Result:

```tsx
<div className="shrink-0 pl-2 pr-1 h-10 md:h-7 flex items-center justify-end">
  <div className="flex items-center gap-0.5">
    <ToolbarIconButton aria-label="Search threads" onClick={…}>…
```

- [ ] **Step 3: Remove suggestion + checklist hooks usage**

Delete:
```typescript
const { isLoading: isLoadingSuggestions, suggestions } = useSuggestedActions(…);
const { isLoading: isLoadingChecklists, checklists } = useStudioPackChecklists(org.slug);
const visibleChecklists = checklists.filter(…);
```

- [ ] **Step 4: Remove dialog state + mounts**

Delete the four `useState` lines for `githubPickerOpen`, `installGithubOpen`, `addStorefrontOpen`, `siteMonitoringOpen`. Delete the `<GitHubRepoPicker>`, `<InstallGitHubMcpDialog>`, `<AddStorefrontModal>`, `<SetupSiteMonitoringModal>` mounts at the bottom of the JSX. Delete `invalidateChecklists`, `handleSuggestionClick`, `handleChecklistItemClick`, `dispatchChecklistAction`, and the unused `locator` from `useProjectContext()` if it has no other reference.

- [ ] **Step 5: Remove the suggestion/checklist JSX branch**

Delete the `viewMode === "suggestions"` branch — the entire block rendering `visibleChecklists.flatMap(...)` + suggestion buttons. Replace the conditional with a direct render of the always-on grouped view:

```tsx
{groupBy === "status" ? (
  <>
    {groupThreadsByStatus(typeFiltered(memberFiltered(sortedThreads))).map(…)}
    {isFetchingMore && <div …>Loading more…</div>}
    {hasMore && <div ref={lastElementRef} aria-hidden />}
  </>
) : (
  <>
    {groups.map((group) => { … })}
    {isFetchingMore && <div …>Loading more…</div>}
    {hasMore && <div ref={lastElementRef} aria-hidden />}
  </>
)}
```

- [ ] **Step 6: Delete the `ChecklistItemCard` component**

Remove the entire `function ChecklistItemCard({ checklist, item, onClick }) { … }` at the bottom of the file.

- [ ] **Step 7: Typecheck + lint**

Run: `bun run --cwd=apps/mesh check && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx
git commit -m "refactor(sidebar): drop \"Up next\" view-mode from task-groups list"
```

---

### Task 12: Remove studio-pack welcome materializer from chat-context

**Files:**
- Modify: `apps/mesh/src/web/components/chat/chat-context.tsx`

- [ ] **Step 1: Delete the materializer useEffect**

In `apps/mesh/src/web/components/chat/chat-context.tsx`, locate the `useEffect` block starting around line 1046 (comment: "Studio Pack welcome materializer") and delete it through the closing `}, [shouldAutosend, …]);` (around line 1086). Also remove the `isStudioPackAgent` import if no other reference remains in this file.

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/chat/chat-context.tsx
git commit -m "refactor(chat): drop studio-pack welcome materializer effect"
```

---

### Task 13: Filter dangling `thrd_welcome_*` threads in the sidebar (TDD)

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`
- Modify: `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts`:

```typescript
describe("groupThreadsByVirtualMcp - dangling welcome threads", () => {
  it("filters out threads whose id starts with thrd_welcome_", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "thrd_welcome_studio-brand-manager_org-1",
          virtual_mcp_id: "studio-brand-manager_org-1",
        }),
        t({
          id: "real-thread",
          virtual_mcp_id: "studio-brand-manager_org-1",
        }),
      ],
      null,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.threads.map((th) => th.id)).toEqual(["real-thread"]);
  });

  it("hides the group entirely when only welcome threads remain", () => {
    const result = groupThreadsByVirtualMcp(
      [
        t({
          id: "thrd_welcome_studio-store-manager_org-1",
          virtual_mcp_id: "studio-store-manager_org-1",
        }),
      ],
      null,
    );
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts -v`
Expected: FAIL — first assertion gets 1 thread in the group instead of filtered output.

- [ ] **Step 3: Add the filter**

In `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`, modify `groupThreadsByVirtualMcp` to skip welcome threads at the top of its loop:

```typescript
export function groupThreadsByVirtualMcp(
  threads: Task[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const byId = new Map<string, TaskGroupData>();

  for (const thread of threads) {
    // Defensive: existing orgs may have dangling pre-seeded welcome threads
    // from the old studio-pack scaffolding. Those rows are harmless but
    // would otherwise surface as empty rows under each studio-pack agent.
    if (thread.id.startsWith("thrd_welcome_")) continue;
    const key = thread.virtual_mcp_id ?? TOOL_CALL_RUNS_GROUP_KEY;
    // ...rest unchanged
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts apps/mesh/src/web/components/sidebar/task-groups/group-threads.test.ts
git commit -m "fix(sidebar): hide dangling thrd_welcome_* rows from groups"
```

---

### Task 14: Remove `createWelcomeThreadsStep` from the install workflow

**Files:**
- Modify: `apps/mesh/src/auth/install-studio-pack-workflow.ts`

- [ ] **Step 1: Delete the step + its call**

Remove the entire `createWelcomeThreadsStep` function and the `await DBOS.runStep(() => createWelcomeThreadsStep(input), …)` line from `installStudioPackWorkflowFn`. Also remove the unused `SqlThreadStorage` import. The workflow after edit:

```typescript
async function installStudioPackWorkflowFn(
  input: InstallStudioPackInput,
): Promise<void> {
  await DBOS.runStep(() => installStudioPackStep(input), {
    name: "installStudioPack",
  });
  await DBOS.runStep(() => backfillSelectedPromptsStep(input), {
    name: "backfillSelectedPrompts",
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/auth/install-studio-pack-workflow.ts
git commit -m "refactor(studio-pack): stop creating welcome threads on install"
```

---

### Task 15: Delete the welcome-route and unmount it

**Files:**
- Delete: `apps/mesh/src/api/routes/studio-pack-welcome.ts`
- Modify: `apps/mesh/src/api/routes/org-scoped.ts`

- [ ] **Step 1: Delete the route file**

```bash
rm apps/mesh/src/api/routes/studio-pack-welcome.ts
```

- [ ] **Step 2: Remove the import + mount**

In `apps/mesh/src/api/routes/org-scoped.ts`, remove:
```typescript
import { createStudioPackWelcomeRoutes } from "./studio-pack-welcome";
// …
app.route("/", createStudioPackWelcomeRoutes());
```

- [ ] **Step 3: Typecheck + boot the server**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/api/routes/org-scoped.ts
git rm apps/mesh/src/api/routes/studio-pack-welcome.ts
git commit -m "refactor(api): remove studio-pack-welcome route"
```

---

### Task 16: Remove `welcomeMessage` from each studio-pack agent + the type

**Files:**
- Modify: `apps/mesh/src/tools/virtual/studio-pack/{brand,agent,automation,connection,store,storefront}-manager.ts`
- Modify: `apps/mesh/src/tools/virtual/studio-pack/types.ts`

- [ ] **Step 1: Strip `welcomeMessage` from each agent**

In each of `brand-manager.ts`, `agent-manager.ts`, `automation-manager.ts`, `connection-manager.ts`, `store-manager.ts`, `storefront-manager.ts`:

- Delete the `welcomeMessage: (async (ctx: WelcomeContext) => …) satisfies BuildWelcomeMessage,` block.
- Remove `BuildWelcomeMessage` and `WelcomeContext` from the `import type { … } from "./types"` line.

- [ ] **Step 2: Remove the type definitions**

In `apps/mesh/src/tools/virtual/studio-pack/types.ts`:

- Delete the `WelcomeContext` type.
- Delete the `BuildWelcomeMessage` type alias.

- [ ] **Step 3: Drop the `prompt?` field from `open-agent-thread`**

Also in `types.ts`, change:

```typescript
export type ChecklistItemAction =
  | { kind: "open-agent-thread"; prompt?: string }
  | … ;
```

to:

```typescript
export type ChecklistItemAction =
  | { kind: "open-agent-thread" }
  | { kind: "github-import" }
  | { kind: "install-github-mcp" }
  | { kind: "add-storefront" }
  | { kind: "configure-github-automations" }
  | { kind: "setup-site-monitoring" };
```

- [ ] **Step 4: Update agent files that referenced `action.prompt`**

In `brand-manager.ts`'s `checklist`, remove the `prompt: "…"` fields from each item's `action` (the autosend text now lives in `studio-pack-onboarding.ts`):

```typescript
{
  label: "Complete your brand profile",
  activeForm: "Completing your brand profile",
  action: { kind: "open-agent-thread" },
  isCompleted: async ({ orgId, ctx }) => { /* unchanged */ },
},
```

Same for `store-manager.ts`'s "Browse the Deco Store" item.

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/tools/virtual/studio-pack
git commit -m "refactor(studio-pack): drop welcomeMessage + prompt field from agents"
```

---

### Task 17: Delete the old studio-pack-checklists route + hook + useSuggestedActions

**Files:**
- Delete: `apps/mesh/src/api/routes/studio-pack-checklists.ts`
- Delete: `apps/mesh/src/web/layouts/tasks-panel/use-studio-pack-checklists.ts`
- Delete: `apps/mesh/src/web/layouts/tasks-panel/use-suggested-actions.ts`
- Modify: `apps/mesh/src/api/routes/org-scoped.ts`
- Modify: `apps/mesh/src/web/lib/query-keys.ts`

- [ ] **Step 1: Verify nothing imports the soon-to-be-deleted modules**

Run:
```bash
bun run lint
```
Or grep:
```
rg "use-studio-pack-checklists|use-suggested-actions|studio-pack-checklists" apps/mesh/src
```
Expected: only the files we're about to delete reference them. If anything else does (e.g., a leftover in Task 11), fix it now.

- [ ] **Step 2: Delete the files**

```bash
rm apps/mesh/src/api/routes/studio-pack-checklists.ts
rm apps/mesh/src/web/layouts/tasks-panel/use-studio-pack-checklists.ts
rm apps/mesh/src/web/layouts/tasks-panel/use-suggested-actions.ts
```

- [ ] **Step 3: Unmount the route**

In `apps/mesh/src/api/routes/org-scoped.ts`, remove:
```typescript
import { createStudioPackChecklistsRoutes } from "./studio-pack-checklists";
// …
app.route("/", createStudioPackChecklistsRoutes());
```

Also remove `import { createSuggestedActionsRoutes } from "./suggested-actions";` and its `app.route(...)` line if no caller remains. (Verify with `rg "createSuggestedActionsRoutes"` first — only delete if no UI code uses it.)

- [ ] **Step 4: Remove the old query keys**

In `apps/mesh/src/web/lib/query-keys.ts`, delete the `studioPackChecklists` and `suggestedActions` entries (only delete `suggestedActions` if step 3 removed the route too — they're a unit).

- [ ] **Step 5: Typecheck + lint + knip**

Run: `bun run --cwd=apps/mesh check && bun run lint && bun run knip`
Expected: PASS (no unused exports flagged).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove old studio-pack-checklists + suggested-actions surface"
```

---

### Task 18: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS for all changed files; no new regressions.

- [ ] **Step 2: Run formatter, type-check, lint, knip**

Run: `bun run fmt && bun run --cwd=apps/mesh check && bun run lint && bun run knip`
Expected: PASS.

- [ ] **Step 3: Smoke test in dev**

- Boot a fresh org (or a backfilled existing org). Confirm the home shows next-action cards.
- Click "Complete your brand profile" → new thread opens with the resolved prompt as the first user message, agent responds.
- Click "Connect GitHub" (dialog card) → InstallGitHubMcpDialog opens. On close, the card disappears.
- Sidebar shows no "Up next" toggle and no dangling `thrd_welcome_*` rows under studio-pack agents.
- Type `/brand-manager-complete-profile` in any chat → the prompt mention is selectable (Studio Pack agent context) or absent (other agent), proving `selected_prompts` whitelisting works.

- [ ] **Step 4: Commit any final formatting changes**

```bash
git add -u
git diff --cached --stat
git commit -m "chore: final formatting after refactor" || true
```

---

## Self-review notes

- **Spec coverage:** Tasks 1–4 cover server-side prompts + selected_prompts whitelist + backfill (spec §"Server side" items 1–2 and "Migration & rollout"). Task 5 covers the new endpoint (spec §"Server side" item 3). Tasks 7–10 cover the home surface (spec §"Frontend side" items 1–3 + 5). Task 8 is the reusable hook + tests (spec §"Architecture — Data flow" and "Reuse map"). Tasks 11–17 cover removal of the old surface (spec §"Removed server code", §"Sidebar simplification", §"chat-context", §"Defensive UI filter"). Task 18 verifies.

- **Type consistency:** `selectedPrompts` is `readonly string[]` on every agent. `HomePromptEntry.hasArguments` + `arguments?` mirror the server's `PromptEntry` shape. `DialogKind` union matches the server's enum.

- **Open server question:** The slug convention in Task 5 (`agent.id + "-" + slugified label`) is a one-to-one mapping with the prompt names in Task 1. If you change one, change the other.

- **Knip risk:** the old `BuildWelcomeMessage` / `WelcomeContext` types removal (Task 16) and the `ChecklistItemAction.prompt?` field removal cascade through several agent files. If `bun run knip` flags lingering unused exports after Task 17, hunt them and fix inline — do not silence knip per CLAUDE.md.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-26-home-next-actions-prompts.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
