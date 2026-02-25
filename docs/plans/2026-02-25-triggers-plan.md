# Triggers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Triggers feature — "When X happens, do Y" automations — with cron and event-based scheduling, tool call and agent prompt actions, backed by the existing event bus.

**Architecture:** New `triggers` table + storage layer + MCP tools (TRIGGER_CREATE/LIST/GET/UPDATE/DELETE) + trigger executor wired to event bus. UI is a list page with card-rows + a "When…Then…" create dialog. Sidebar nav under Build group.

**Tech Stack:** Kysely (migration + storage), Zod (schemas), defineTool() (MCP tools), React 19 + TanStack Router (UI), croner (cron parsing), @untitledui/icons

---

## Task 1: Database Migration

**Files:**
- Create: `apps/mesh/migrations/035-triggers.ts`
- Modify: `apps/mesh/migrations/index.ts`

**Step 1: Create migration file**

```typescript
// apps/mesh/migrations/035-triggers.ts
import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("triggers")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text")
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("cron_expression", "text")
    .addColumn("event_type", "text")
    .addColumn("event_filter", "text")
    .addColumn("action_type", "text", (col) => col.notNull())
    .addColumn("connection_id", "text")
    .addColumn("tool_name", "text")
    .addColumn("tool_arguments", "text")
    .addColumn("agent_id", "text")
    .addColumn("agent_prompt", "text")
    .addColumn("event_id", "text")
    .addColumn("subscription_id", "text")
    .addColumn("last_run_at", "text")
    .addColumn("last_run_status", "text")
    .addColumn("last_run_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("updated_by", "text")
    .execute();

  await db.schema
    .createIndex("idx_triggers_org")
    .on("triggers")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_triggers_org_enabled")
    .on("triggers")
    .columns(["organization_id", "enabled"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_triggers_org_enabled").execute();
  await db.schema.dropIndex("idx_triggers_org").execute();
  await db.schema.dropTable("triggers").execute();
}
```

**Step 2: Register migration**

In `apps/mesh/migrations/index.ts`:
- Add import: `import * as migration035triggers from "./035-triggers.ts";`  (after line 35)
- Add to migrations object: `"035-triggers": migration035triggers,` (after line 80)

**Step 3: Run migration**

Run: `cd apps/mesh && bun run migrate`
Expected: Migration 035-triggers applied successfully.

**Step 4: Commit**

```bash
git add apps/mesh/migrations/035-triggers.ts apps/mesh/migrations/index.ts
git commit -m "feat(triggers): add triggers database migration"
```

---

## Task 2: Storage Types

**Files:**
- Modify: `apps/mesh/src/storage/types.ts`

**Step 1: Add TriggerTable interface**

Add after the existing table definitions (after the event bus types, around line 620):

```typescript
// ============================================================================
// Trigger Table Definitions
// ============================================================================

export type TriggerType = "cron" | "event";
export type TriggerActionType = "tool_call" | "agent_prompt";
export type TriggerRunStatus = "success" | "failed";

export interface TriggerTable {
  id: string;
  organization_id: string;
  title: string | null;
  enabled: number; // SQLite boolean (0 or 1)
  trigger_type: TriggerType;
  cron_expression: string | null;
  event_type: string | null;
  event_filter: string | null;
  action_type: TriggerActionType;
  connection_id: string | null;
  tool_name: string | null;
  tool_arguments: string | null;
  agent_id: string | null;
  agent_prompt: string | null;
  event_id: string | null;
  subscription_id: string | null;
  last_run_at: string | null;
  last_run_status: TriggerRunStatus | null;
  last_run_error: string | null;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  created_by: string;
  updated_by: string | null;
}
```

**Step 2: Add triggers to Database interface**

Find the `Database` interface and add `triggers: TriggerTable;` alongside the other tables.

**Step 3: Commit**

```bash
git add apps/mesh/src/storage/types.ts
git commit -m "feat(triggers): add trigger storage types"
```

---

## Task 3: Storage Layer

**Files:**
- Create: `apps/mesh/src/storage/triggers.ts`

**Step 1: Create trigger storage**

```typescript
// apps/mesh/src/storage/triggers.ts
import type { Kysely } from "kysely";
import type {
  Database,
  TriggerActionType,
  TriggerRunStatus,
  TriggerType,
} from "./types";

export interface TriggerEntity {
  id: string;
  organizationId: string;
  title: string | null;
  enabled: boolean;
  triggerType: TriggerType;
  cronExpression: string | null;
  eventType: string | null;
  eventFilter: string | null;
  actionType: TriggerActionType;
  connectionId: string | null;
  toolName: string | null;
  toolArguments: string | null;
  agentId: string | null;
  agentPrompt: string | null;
  eventId: string | null;
  subscriptionId: string | null;
  lastRunAt: string | null;
  lastRunStatus: TriggerRunStatus | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string | null;
}

function toEntity(row: Record<string, unknown>): TriggerEntity {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    title: row.title as string | null,
    enabled: row.enabled === 1,
    triggerType: row.trigger_type as TriggerType,
    cronExpression: row.cron_expression as string | null,
    eventType: row.event_type as string | null,
    eventFilter: row.event_filter as string | null,
    actionType: row.action_type as TriggerActionType,
    connectionId: row.connection_id as string | null,
    toolName: row.tool_name as string | null,
    toolArguments: row.tool_arguments as string | null,
    agentId: row.agent_id as string | null,
    agentPrompt: row.agent_prompt as string | null,
    eventId: row.event_id as string | null,
    subscriptionId: row.subscription_id as string | null,
    lastRunAt: row.last_run_at as string | null,
    lastRunStatus: row.last_run_status as TriggerRunStatus | null,
    lastRunError: row.last_run_error as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string | null,
  };
}

export class TriggerStorage {
  constructor(private db: Kysely<Database>) {}

  async create(input: {
    id: string;
    organizationId: string;
    title?: string | null;
    triggerType: TriggerType;
    cronExpression?: string | null;
    eventType?: string | null;
    eventFilter?: string | null;
    actionType: TriggerActionType;
    connectionId?: string | null;
    toolName?: string | null;
    toolArguments?: string | null;
    agentId?: string | null;
    agentPrompt?: string | null;
    createdBy: string;
  }): Promise<TriggerEntity> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("triggers")
      .values({
        id: input.id,
        organization_id: input.organizationId,
        title: input.title ?? null,
        enabled: 1,
        trigger_type: input.triggerType,
        cron_expression: input.cronExpression ?? null,
        event_type: input.eventType ?? null,
        event_filter: input.eventFilter ?? null,
        action_type: input.actionType,
        connection_id: input.connectionId ?? null,
        tool_name: input.toolName ?? null,
        tool_arguments: input.toolArguments ?? null,
        agent_id: input.agentId ?? null,
        agent_prompt: input.agentPrompt ?? null,
        created_at: now,
        updated_at: now,
        created_by: input.createdBy,
      })
      .execute();

    const trigger = await this.get(input.id);
    if (!trigger) throw new Error("Failed to create trigger");
    return trigger;
  }

  async get(id: string): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }

  async list(organizationId: string): Promise<TriggerEntity[]> {
    const rows = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => toEntity(row as Record<string, unknown>));
  }

  async update(
    id: string,
    input: {
      title?: string | null;
      enabled?: boolean;
      triggerType?: TriggerType;
      cronExpression?: string | null;
      eventType?: string | null;
      eventFilter?: string | null;
      actionType?: TriggerActionType;
      connectionId?: string | null;
      toolName?: string | null;
      toolArguments?: string | null;
      agentId?: string | null;
      agentPrompt?: string | null;
      eventId?: string | null;
      subscriptionId?: string | null;
      lastRunAt?: string | null;
      lastRunStatus?: TriggerRunStatus | null;
      lastRunError?: string | null;
      updatedBy?: string;
    },
  ): Promise<TriggerEntity> {
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { updated_at: now };

    if (input.title !== undefined) values.title = input.title;
    if (input.enabled !== undefined) values.enabled = input.enabled ? 1 : 0;
    if (input.triggerType !== undefined) values.trigger_type = input.triggerType;
    if (input.cronExpression !== undefined)
      values.cron_expression = input.cronExpression;
    if (input.eventType !== undefined) values.event_type = input.eventType;
    if (input.eventFilter !== undefined) values.event_filter = input.eventFilter;
    if (input.actionType !== undefined) values.action_type = input.actionType;
    if (input.connectionId !== undefined)
      values.connection_id = input.connectionId;
    if (input.toolName !== undefined) values.tool_name = input.toolName;
    if (input.toolArguments !== undefined)
      values.tool_arguments = input.toolArguments;
    if (input.agentId !== undefined) values.agent_id = input.agentId;
    if (input.agentPrompt !== undefined) values.agent_prompt = input.agentPrompt;
    if (input.eventId !== undefined) values.event_id = input.eventId;
    if (input.subscriptionId !== undefined)
      values.subscription_id = input.subscriptionId;
    if (input.lastRunAt !== undefined) values.last_run_at = input.lastRunAt;
    if (input.lastRunStatus !== undefined)
      values.last_run_status = input.lastRunStatus;
    if (input.lastRunError !== undefined)
      values.last_run_error = input.lastRunError;
    if (input.updatedBy !== undefined) values.updated_by = input.updatedBy;

    await this.db
      .updateTable("triggers")
      .set(values)
      .where("id", "=", id)
      .execute();

    const trigger = await this.get(id);
    if (!trigger) throw new Error("Trigger not found");
    return trigger;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("triggers").where("id", "=", id).execute();
  }

  async listEnabled(organizationId: string): Promise<TriggerEntity[]> {
    const rows = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("enabled", "=", 1)
      .execute();

    return rows.map((row) => toEntity(row as Record<string, unknown>));
  }

  async findByEventId(eventId: string): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("event_id", "=", eventId)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }

  async findBySubscriptionId(
    subscriptionId: string,
  ): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("subscription_id", "=", subscriptionId)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }
}
```

**Step 2: Wire storage into MeshContext**

In `apps/mesh/src/core/mesh-context.ts`:
- Add import: `import type { TriggerStorage } from "../storage/triggers";` (around line 234)
- Add to `MeshStorage` interface: `triggers: TriggerStorage;` (around line 262)

In `apps/mesh/src/core/context-factory.ts`:
- Add import: `import { TriggerStorage } from "@/storage/triggers";` (near other storage imports)
- Add to storage object (around line 749): `triggers: new TriggerStorage(config.db),`

**Step 3: Commit**

```bash
git add apps/mesh/src/storage/triggers.ts apps/mesh/src/core/mesh-context.ts apps/mesh/src/core/context-factory.ts
git commit -m "feat(triggers): add trigger storage layer"
```

---

## Task 4: MCP Tool Schemas

**Files:**
- Create: `apps/mesh/src/tools/triggers/schema.ts`

**Step 1: Create schema file**

```typescript
// apps/mesh/src/tools/triggers/schema.ts
import { z } from "zod";

export const TriggerTypeSchema = z.enum(["cron", "event"]);
export const TriggerActionTypeSchema = z.enum(["tool_call", "agent_prompt"]);

export const CreateTriggerInputSchema = z.object({
  title: z.string().optional().nullable().describe("Optional name for the trigger"),
  triggerType: TriggerTypeSchema.describe("Type of trigger: cron schedule or event listener"),
  cronExpression: z.string().optional().nullable().describe("Cron expression (required when triggerType=cron)"),
  eventType: z.string().optional().nullable().describe("Event type to listen for (required when triggerType=event)"),
  eventFilter: z.string().optional().nullable().describe("JSONPath filter on event data"),
  actionType: TriggerActionTypeSchema.describe("Action to execute: tool_call or agent_prompt"),
  connectionId: z.string().optional().nullable().describe("Connection ID (required when actionType=tool_call)"),
  toolName: z.string().optional().nullable().describe("Tool name (required when actionType=tool_call)"),
  toolArguments: z.string().optional().nullable().describe("JSON arguments for tool call"),
  agentId: z.string().optional().nullable().describe("Virtual MCP ID (required when actionType=agent_prompt)"),
  agentPrompt: z.string().optional().nullable().describe("Prompt text (required when actionType=agent_prompt)"),
});

export const TriggerOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string().nullable(),
  enabled: z.boolean(),
  triggerType: TriggerTypeSchema,
  cronExpression: z.string().nullable(),
  eventType: z.string().nullable(),
  eventFilter: z.string().nullable(),
  actionType: TriggerActionTypeSchema,
  connectionId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolArguments: z.string().nullable(),
  agentId: z.string().nullable(),
  agentPrompt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  lastRunError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});

export const TriggerListOutputSchema = z.object({
  triggers: z.array(TriggerOutputSchema),
});

export const UpdateTriggerInputSchema = z.object({
  id: z.string().describe("Trigger ID to update"),
  title: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  triggerType: TriggerTypeSchema.optional(),
  cronExpression: z.string().optional().nullable(),
  eventType: z.string().optional().nullable(),
  eventFilter: z.string().optional().nullable(),
  actionType: TriggerActionTypeSchema.optional(),
  connectionId: z.string().optional().nullable(),
  toolName: z.string().optional().nullable(),
  toolArguments: z.string().optional().nullable(),
  agentId: z.string().optional().nullable(),
  agentPrompt: z.string().optional().nullable(),
});

export const TriggerIdInputSchema = z.object({
  id: z.string().describe("Trigger ID"),
});

export const DeleteTriggerOutputSchema = z.object({
  success: z.boolean(),
});
```

**Step 2: Commit**

```bash
git add apps/mesh/src/tools/triggers/schema.ts
git commit -m "feat(triggers): add trigger tool schemas"
```

---

## Task 5: MCP Tools (CRUD)

**Files:**
- Create: `apps/mesh/src/tools/triggers/create.ts`
- Create: `apps/mesh/src/tools/triggers/list.ts`
- Create: `apps/mesh/src/tools/triggers/get.ts`
- Create: `apps/mesh/src/tools/triggers/update.ts`
- Create: `apps/mesh/src/tools/triggers/delete.ts`
- Create: `apps/mesh/src/tools/triggers/index.ts`

**Step 1: Create TRIGGER_CREATE tool**

```typescript
// apps/mesh/src/tools/triggers/create.ts
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { CreateTriggerInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_CREATE = defineTool({
  name: "TRIGGER_CREATE",
  description: "Create a new trigger automation (cron schedule or event listener)",
  annotations: {
    title: "Create Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: CreateTriggerInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Validate trigger type specific fields
    if (input.triggerType === "cron" && !input.cronExpression) {
      throw new Error("cronExpression is required for cron triggers");
    }
    if (input.triggerType === "event" && !input.eventType) {
      throw new Error("eventType is required for event triggers");
    }
    if (input.actionType === "tool_call" && (!input.connectionId || !input.toolName)) {
      throw new Error("connectionId and toolName are required for tool_call actions");
    }
    if (input.actionType === "agent_prompt" && (!input.agentId || !input.agentPrompt)) {
      throw new Error("agentId and agentPrompt are required for agent_prompt actions");
    }

    const trigger = await ctx.storage.triggers.create({
      id: `trig_${crypto.randomUUID()}`,
      organizationId: organization.id,
      title: input.title,
      triggerType: input.triggerType,
      cronExpression: input.cronExpression,
      eventType: input.eventType,
      eventFilter: input.eventFilter,
      actionType: input.actionType,
      connectionId: input.connectionId,
      toolName: input.toolName,
      toolArguments: input.toolArguments,
      agentId: input.agentId,
      agentPrompt: input.agentPrompt,
      createdBy: ctx.user.id,
    });

    return trigger;
  },
});
```

**Step 2: Create TRIGGER_LIST tool**

```typescript
// apps/mesh/src/tools/triggers/list.ts
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerListOutputSchema } from "./schema";

export const TRIGGER_LIST = defineTool({
  name: "TRIGGER_LIST",
  description: "List all triggers for the organization",
  annotations: {
    title: "List Triggers",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: TriggerListOutputSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const triggers = await ctx.storage.triggers.list(organization.id);
    return { triggers };
  },
});
```

**Step 3: Create TRIGGER_GET tool**

```typescript
// apps/mesh/src/tools/triggers/get.ts
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerIdInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_GET = defineTool({
  name: "TRIGGER_GET",
  description: "Get trigger details by ID",
  annotations: {
    title: "Get Trigger",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: TriggerIdInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const trigger = await ctx.storage.triggers.get(input.id);
    if (!trigger) throw new Error(`Trigger not found: ${input.id}`);
    return trigger;
  },
});
```

**Step 4: Create TRIGGER_UPDATE tool**

```typescript
// apps/mesh/src/tools/triggers/update.ts
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { UpdateTriggerInputSchema, TriggerOutputSchema } from "./schema";

export const TRIGGER_UPDATE = defineTool({
  name: "TRIGGER_UPDATE",
  description: "Update trigger configuration (including enable/disable)",
  annotations: {
    title: "Update Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateTriggerInputSchema,
  outputSchema: TriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const { id, ...updates } = input;
    const trigger = await ctx.storage.triggers.update(id, {
      ...updates,
      updatedBy: ctx.user.id,
    });
    return trigger;
  },
});
```

**Step 5: Create TRIGGER_DELETE tool**

```typescript
// apps/mesh/src/tools/triggers/delete.ts
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerIdInputSchema, DeleteTriggerOutputSchema } from "./schema";

export const TRIGGER_DELETE = defineTool({
  name: "TRIGGER_DELETE",
  description: "Delete a trigger and clean up its event bus references",
  annotations: {
    title: "Delete Trigger",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: TriggerIdInputSchema,
  outputSchema: DeleteTriggerOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const trigger = await ctx.storage.triggers.get(input.id);
    if (!trigger) throw new Error(`Trigger not found: ${input.id}`);

    // TODO: Clean up event bus references (cancel cron event, unsubscribe)

    await ctx.storage.triggers.delete(input.id);
    return { success: true };
  },
});
```

**Step 6: Create index file**

```typescript
// apps/mesh/src/tools/triggers/index.ts
export { TRIGGER_CREATE } from "./create";
export { TRIGGER_LIST } from "./list";
export { TRIGGER_GET } from "./get";
export { TRIGGER_UPDATE } from "./update";
export { TRIGGER_DELETE } from "./delete";
```

**Step 7: Commit**

```bash
git add apps/mesh/src/tools/triggers/
git commit -m "feat(triggers): add CRUD MCP tools"
```

---

## Task 6: Register Tools

**Files:**
- Modify: `apps/mesh/src/tools/index.ts`
- Modify: `apps/mesh/src/tools/registry.ts`

**Step 1: Register in tool index**

In `apps/mesh/src/tools/index.ts`:
- Add import after line 24: `import * as TriggerTools from "./triggers";`
- Add to CORE_TOOLS array after Event Bus tools (after line 99):

```typescript
  // Trigger tools
  TriggerTools.TRIGGER_CREATE,
  TriggerTools.TRIGGER_LIST,
  TriggerTools.TRIGGER_GET,
  TriggerTools.TRIGGER_UPDATE,
  TriggerTools.TRIGGER_DELETE,
```

**Step 2: Register in tool registry**

In `apps/mesh/src/tools/registry.ts`:
- Add `"Triggers"` to the `ToolCategory` type (line 33)
- Add tool names to `ALL_TOOL_NAMES` array (after Event Bus tools, around line 95):

```typescript
  // Trigger tools
  "TRIGGER_CREATE",
  "TRIGGER_LIST",
  "TRIGGER_GET",
  "TRIGGER_UPDATE",
  "TRIGGER_DELETE",
```

- Add tool metadata to `MANAGEMENT_TOOLS` array (after Event Bus section, around line 418):

```typescript
  // Trigger tools
  { name: "TRIGGER_CREATE", description: "Create triggers", category: "Triggers" },
  { name: "TRIGGER_LIST", description: "List triggers", category: "Triggers" },
  { name: "TRIGGER_GET", description: "View trigger details", category: "Triggers" },
  { name: "TRIGGER_UPDATE", description: "Update triggers", category: "Triggers" },
  { name: "TRIGGER_DELETE", description: "Delete triggers", category: "Triggers", dangerous: true },
```

- Add labels to `TOOL_LABELS` (after Event Bus labels, around line 591):

```typescript
  TRIGGER_CREATE: "Create triggers",
  TRIGGER_LIST: "List triggers",
  TRIGGER_GET: "View trigger details",
  TRIGGER_UPDATE: "Update triggers",
  TRIGGER_DELETE: "Delete triggers",
```

- Add `Triggers: []` to the `getToolsByCategory` grouped object (around line 638)

**Step 3: Verify**

Run: `bun run check` (TypeScript type checking)
Expected: No type errors.

**Step 4: Commit**

```bash
git add apps/mesh/src/tools/index.ts apps/mesh/src/tools/registry.ts
git commit -m "feat(triggers): register trigger tools in tool registry"
```

---

## Task 7: Query Keys + Sidebar Navigation

**Files:**
- Modify: `apps/mesh/src/web/lib/query-keys.ts`
- Modify: `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx`

**Step 1: Add query keys**

In `apps/mesh/src/web/lib/query-keys.ts`, add after the projects section (around line 218):

```typescript
  // Triggers (scoped by locator)
  triggers: (locator: ProjectLocator) => [locator, "triggers"] as const,
  trigger: (locator: ProjectLocator, triggerId: string) =>
    [locator, "trigger", triggerId] as const,
```

**Step 2: Add sidebar item**

In `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx`:

Add import for icon (line 20, alongside other icons):
```typescript
import { Lightning01 } from "@untitledui/icons";
```

Note: If `Lightning01` is not available, use `Zap` or another appropriate icon. Check the icon library.

Add triggers item after `agentsItem` (after line 128):
```typescript
  const triggersItem: NavigationSidebarItem = {
    key: "triggers",
    label: "Triggers",
    icon: <Lightning01 />,
    isActive: isActiveRoute("triggers"),
    onClick: () =>
      navigate({
        to: "/$org/$project/triggers",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };
```

Add to Build group items array (line 237), change:
```typescript
items: [agentsItem, connectionsItem, storeItem],
```
to:
```typescript
items: [agentsItem, connectionsItem, triggersItem, storeItem],
```

**Step 3: Commit**

```bash
git add apps/mesh/src/web/lib/query-keys.ts apps/mesh/src/web/hooks/use-project-sidebar-items.tsx
git commit -m "feat(triggers): add query keys and sidebar navigation"
```

---

## Task 8: Triggers List Page

**Files:**
- Create: `apps/mesh/src/web/routes/orgs/triggers.tsx`
- Modify: `apps/mesh/src/web/index.tsx` (add route)

**Step 1: Create the list page**

Create `apps/mesh/src/web/routes/orgs/triggers.tsx` following the agents page pattern. This is a full page with:

- Page header with breadcrumb + "New Trigger" button
- Search bar
- Card-row list of triggers (sentence-style: "When X → Then Y")
- Each card shows: trigger type icon, human-readable schedule/event, action description, last run status, enabled toggle
- Empty state when no triggers exist

Key patterns to follow from the agents page (`apps/mesh/src/web/routes/orgs/agents.tsx`):
- Use `useSuspenseQuery` with `KEYS.triggers(locator)` for data fetching
- Use `useProjectContext()` for org context
- Use the MCP client to call `TRIGGER_LIST` tool
- Wrap in Suspense/ErrorBoundary

The card-row component should render:
- Line 1: Icon (Clock04 for cron, Lightning01 for event) + human-readable trigger condition + Switch toggle
- Line 2: Arrow icon + action description ("Call TOOL_NAME on Connection" or "Run agent Agent Name")
- Line 3: "Last run: Xh ago [status]" + "Next: date" (for cron)

Use `croner` library (already a dependency) to convert cron expressions to human-readable and compute next run time.

**Step 2: Add route to index.tsx**

In `apps/mesh/src/web/index.tsx`, add after `agentDetailRoute` (around line 347):

```typescript
const triggersRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/triggers",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(() => import("./routes/orgs/triggers.tsx")),
  validateSearch: z.lazy(() =>
    z.object({
      action: z.enum(["create"]).optional(),
    }),
  ),
});
```

Add `triggersRoute` to the `projectRoutes` array (around line 429, after `agentDetailRoute`).

**Step 3: Format and verify**

Run: `bun run fmt`
Run: `bun run check`

**Step 4: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/triggers.tsx apps/mesh/src/web/index.tsx
git commit -m "feat(triggers): add triggers list page with card-row layout"
```

---

## Task 9: Create Trigger Dialog

**Files:**
- Create: `apps/mesh/src/web/components/triggers/create-trigger-dialog.tsx`

**Step 1: Create dialog component**

The dialog implements the "When…Then…" sentence builder:

**Structure:**
- Name field (optional, at top)
- "When" section with pill toggle: Schedule | Event
  - Schedule: cron expression input + human-readable preview using croner
  - Event: event type text input + optional filter
- "Then" section with pill toggle: Call a Tool | Run an Agent
  - Call a Tool: connection dropdown (fetched from COLLECTION_CONNECTIONS_LIST) → tool dropdown (fetched from connection's tools) → optional JSON args textarea
  - Run an Agent: agent dropdown (fetched from COLLECTION_VIRTUAL_MCP_LIST) → prompt textarea

**Key UX patterns:**
- Pill toggles: two buttons side by side with a sliding background indicator
- Live cron preview: parse expression with `new Cron(expr)` and show `nextRun()` formatted
- Form fields animate in below pill selection with `ease-out` 150ms translateY(4→0)
- Dialog enter: scale(0.97→1) + opacity 200ms ease-out-quint

**Key imports:**
- Dialog components from `@deco/ui/components/dialog.tsx`
- Form/Input from `@deco/ui/components/form.tsx` and `@deco/ui/components/input.tsx`
- Button from `@deco/ui/components/button.tsx`
- Textarea from `@deco/ui/components/textarea.tsx`
- Switch from `@deco/ui/components/switch.tsx`
- Use `react-hook-form` for form state
- Use `useMutation` from `@tanstack/react-query` for submitting
- Call `TRIGGER_CREATE` tool via MCP client

**Animations (CSS):**
```css
/* Pill toggle background */
.pill-indicator {
  transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

/* Form field entrance */
.field-enter {
  animation: fieldEnter 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

@keyframes fieldEnter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .pill-indicator { transition: none; }
  .field-enter { animation: none; }
}
```

**Step 2: Wire dialog to list page**

Import the dialog in `triggers.tsx` and open it when the user clicks "New Trigger" or when `?action=create` is in the URL.

**Step 3: Format and verify**

Run: `bun run fmt`
Run: `bun run check`

**Step 4: Commit**

```bash
git add apps/mesh/src/web/components/triggers/
git commit -m "feat(triggers): add create trigger dialog with When/Then sentence builder"
```

---

## Task 10: Trigger Detail Page

**Files:**
- Create: `apps/mesh/src/web/routes/orgs/trigger-detail.tsx`
- Modify: `apps/mesh/src/web/index.tsx` (add route)

**Step 1: Create detail page**

Uses the `ViewLayout` pattern from existing detail pages. Shows:
- Breadcrumb: Triggers > [trigger title or "Untitled"]
- The same "When…Then…" form as the create dialog, but inline (not in a dialog) and pre-filled
- Save/Cancel buttons in the header actions slot
- Below the form: a "Recent Runs" section showing last_run_at, last_run_status, last_run_error
- Delete button (with confirmation dialog)

Fetch trigger data with `useSuspenseQuery` calling `TRIGGER_GET`.
Update via `useMutation` calling `TRIGGER_UPDATE`.
Delete via `useMutation` calling `TRIGGER_DELETE`.

**Step 2: Add route**

In `apps/mesh/src/web/index.tsx`, add after triggersRoute:

```typescript
const triggerDetailRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/triggers/$triggerId",
  beforeLoad: orgAdminGuard,
  component: lazyRouteComponent(
    () => import("./routes/orgs/trigger-detail.tsx"),
  ),
});
```

Add `triggerDetailRoute` to `projectRoutes` array.

**Step 3: Format and verify**

Run: `bun run fmt`
Run: `bun run check`

**Step 4: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/trigger-detail.tsx apps/mesh/src/web/index.tsx
git commit -m "feat(triggers): add trigger detail page with edit and delete"
```

---

## Task 11: Enable/Disable Toggle

**Files:**
- Modify: `apps/mesh/src/web/routes/orgs/triggers.tsx`

**Step 1: Add inline toggle mutation**

In the triggers list page, each card-row has a Switch component. When toggled:
- Call `TRIGGER_UPDATE` with `{ id, enabled: !current }` via mutation
- Optimistically update the UI (invalidate query on success)
- Show toast on success/error

The Switch should stop event propagation so clicking it doesn't navigate to the detail page.

**Step 2: Format and verify**

Run: `bun run fmt`

**Step 3: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/triggers.tsx
git commit -m "feat(triggers): add inline enable/disable toggle on list page"
```

---

## Task 12: Final Polish and Format

**Files:** All modified files

**Step 1: Run full formatting**

Run: `bun run fmt`

**Step 2: Run type checking**

Run: `bun run check`
Expected: No errors.

**Step 3: Run linting**

Run: `bun run lint`
Expected: No errors (or only pre-existing ones).

**Step 4: Run tests**

Run: `bun test`
Expected: All existing tests pass.

**Step 5: Final commit if any formatting changes**

```bash
git add -A
git commit -m "chore(triggers): format and lint cleanup"
```
