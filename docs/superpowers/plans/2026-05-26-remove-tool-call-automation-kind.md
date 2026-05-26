# Remove Tool-Call Automation Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `kind = "tool_call"` execution mode from automations so every automation runs through the agent path.

**Architecture:** Single forward migration (082) + delete every `tool_call` branch across storage, runtime, MCP tools, and UI. No data preservation: `kind='tool_call'` rows are dropped by the migration. The discriminator + 3 conditional columns + 3 CHECK constraints introduced by migration 078 are reversed; the `virtual_mcp_id` column goes back to `NOT NULL`.

**Tech Stack:** Bun + TypeScript, Kysely migrations, DBOS workflows, React 19 + Vite + TanStack Router.

**Spec:** `docs/superpowers/specs/2026-05-26-remove-tool-call-automation-kind-design.md`

---

## File Inventory

**Create:**
- `apps/mesh/migrations/095-remove-automation-tool-call-kind.ts`

**Modify:**
- `apps/mesh/src/storage/types.ts`
- `apps/mesh/src/storage/automations.ts`
- `apps/mesh/src/automations/dbos-workflow.ts`
- `apps/mesh/src/tools/automations/create.ts`
- `apps/mesh/src/tools/automations/update.ts`
- `apps/mesh/src/tools/automations/get.ts`
- `apps/mesh/src/tools/automations/list.ts`
- `apps/mesh/src/web/hooks/use-automations.ts`
- `apps/mesh/src/web/views/automations/automations-list.tsx`
- `apps/mesh/src/web/views/automations/automation-list-row.tsx`
- `apps/mesh/src/web/views/automations/automation-detail.tsx`
- `apps/mesh/src/web/layouts/main-panel-tabs/automation-tab.tsx`
- `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx`
- `apps/mesh/src/web/layouts/tasks-panel/mcp-avatar.tsx`
- `apps/mesh/src/web/routes/orgs/settings/automations.tsx`
- `apps/mesh/src/automations/automation-event-dispatcher.test.ts`
- `packages/mesh-sdk/src/types/decopilot-events.ts` (doc comment only)

**Delete:**
- `apps/mesh/src/web/views/automations/tool-call-config-fields.tsx`

---

## Task 1: Add migration 095 to drop tool-call schema

**Files:**
- Create: `apps/mesh/migrations/095-remove-automation-tool-call-kind.ts`
- Modify: `apps/mesh/migrations/index.ts` (register the new migration)

**Important:** The migration number 082 is already taken (`082-secrets`). The latest migration is `094-org-file-configs`, so this new migration is **095**.

- [ ] **Step 1: Write the migration file**

```typescript
/**
 * Removes the `kind = "tool_call"` automation mode introduced by migration
 * 078. Forward-only: every kind='tool_call' row is deleted; the four
 * conditional columns + three CHECK constraints are dropped; `virtual_mcp_id`
 * goes back to NOT NULL.
 *
 * `down()` re-creates the schema shape (columns + constraints) but cannot
 * restore deleted rows.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Constraints first — DROP COLUMN won't drop a CHECK that references it
  // on Postgres before the column itself is gone, and dropping the kind
  // CHECK lets the row delete proceed even if any row ended up with an
  // unknown kind value somehow.
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_tool_call_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_agent_fields`.execute(
    db,
  );
  await sql`ALTER TABLE automations DROP CONSTRAINT chk_automation_kind`.execute(
    db,
  );

  // Drop tool-call rows. Their virtual_mcp_id is NULL by construction,
  // so they would block the NOT NULL restoration below.
  await sql`DELETE FROM automations WHERE kind = 'tool_call'`.execute(db);

  // Restore the pre-078 invariant: agent automations always have an agent.
  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id SET NOT NULL
  `.execute(db);

  await db.schema
    .alterTable("automations")
    .dropColumn("tool_input")
    .dropColumn("tool_name")
    .dropColumn("connection_id")
    .dropColumn("kind")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Mirror of migration 078's up(). Restores the schema shape only —
  // any tool_call rows deleted by 082's up() are gone for good.
  await db.schema
    .alterTable("automations")
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("agent"))
    .addColumn("connection_id", "text")
    .addColumn("tool_name", "text")
    .addColumn("tool_input", "text")
    .execute();

  await sql`
    ALTER TABLE automations
    ALTER COLUMN virtual_mcp_id DROP NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_kind
    CHECK (kind IN ('agent', 'tool_call'))
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_agent_fields
    CHECK (kind != 'agent' OR virtual_mcp_id IS NOT NULL)
  `.execute(db);

  await sql`
    ALTER TABLE automations
    ADD CONSTRAINT chk_automation_tool_call_fields
    CHECK (
      kind != 'tool_call'
      OR (
        connection_id IS NOT NULL
        AND tool_name IS NOT NULL
        AND tool_input IS NOT NULL
      )
    )
  `.execute(db);
}
```

- [ ] **Step 2: Register the migration in the index**

`apps/mesh/migrations/index.ts` uses explicit registration. Add an import alongside the others (preserving alphabetical order — after the `094` import):

```typescript
import * as migration095removeautomationtoolcallkind from "./095-remove-automation-tool-call-kind.ts";
```

And add an entry to the `migrations` object after `"094-org-file-configs": migration094orgfileconfigs,`:

```typescript
  "095-remove-automation-tool-call-kind":
    migration095removeautomationtoolcallkind,
```

- [ ] **Step 3: Do not run the migration yet**

The migration depends on column references that the storage layer still has. Leaving it un-applied until storage/runtime are updated avoids a half-broken dev server. Final task runs the migration after all code edits land.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/migrations/095-remove-automation-tool-call-kind.ts apps/mesh/migrations/index.ts
git commit -m "feat(automations): add migration 095 to remove tool-call kind"
```

---

## Task 2: Strip tool-call fields from storage types

**Files:**
- Modify: `apps/mesh/src/storage/types.ts:1101-1146`

- [ ] **Step 1: Edit `AutomationTable`**

Replace lines 1097–1123 with:

```typescript
/**
 * Automation table definition
 * Stores automation configurations with agent, messages, and model settings
 */
export interface AutomationTable {
  id: string;
  organization_id: string;
  name: string;
  active: boolean;
  created_by: string;
  messages: string;
  models: string;
  temperature: number;
  virtual_mcp_id: string;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}
```

- [ ] **Step 2: Edit `Automation` runtime type**

Replace lines 1125–1146 with:

```typescript
/**
 * Automation entity - Runtime representation
 */
export interface Automation {
  id: string;
  organization_id: string;
  name: string;
  active: boolean;
  created_by: string;
  messages: string;
  models: string;
  temperature: number;
  virtual_mcp_id: string;
  created_at: string;
  updated_at: string;
}
```

The `AutomationKind` type alias (line 1125 in the original) is removed entirely — no replacement.

- [ ] **Step 3: Commit (with broken-build allowed — fixed in next tasks)**

The repo will not typecheck until Task 3 updates `automations.ts`. Commit anyway so each task stays bite-sized; the integration commit at the end runs `bun run check`.

```bash
git add apps/mesh/src/storage/types.ts
git commit -m "refactor(automations): drop tool-call fields from storage types"
```

---

## Task 3: Simplify automations storage adapter

**Files:**
- Modify: `apps/mesh/src/storage/automations.ts`

- [ ] **Step 1: Drop the `AutomationKind` import**

In the top imports, replace lines 15–20:

```typescript
import type { Database, Automation, AutomationTrigger } from "./types";
```

- [ ] **Step 2: Simplify `CreateAutomationInput`**

Replace lines 26–41 with:

```typescript
export interface CreateAutomationInput {
  organization_id: string;
  name: string;
  active?: boolean;
  created_by: string;
  messages: string; // JSON
  models: string; // JSON
  temperature?: number;
  virtual_mcp_id: string;
}
```

- [ ] **Step 3: Simplify `UpdateAutomationInput`**

Replace lines 43–54 with:

```typescript
export interface UpdateAutomationInput {
  name?: string;
  active?: boolean;
  messages?: string;
  models?: string;
  temperature?: number;
}
```

- [ ] **Step 4: Remove `createToolCallRunThread` from the interface**

In `AutomationsStorage` (around lines 114–125), delete the `createToolCallRunThread` declaration (and its leading doc comment):

Remove:
```typescript
  // Spawns a thread for a kind='tool_call' run. Uses empty-string
  // virtual_mcp_id (the same sentinel migration 057 reserves for
  // agent-less threads) and stamps metadata.kind so the UI can render
  // the row + thread detail differently from agent runs.
  createToolCallRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string>;
```

- [ ] **Step 5: Simplify `automationFromDbRow`**

Replace the function body (lines 140–179) with:

```typescript
function automationFromDbRow(row: {
  id: string;
  organization_id: string;
  name: string;
  active: boolean | number;
  created_by: string;
  messages: string;
  models: string;
  temperature: number;
  virtual_mcp_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}): Automation {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    active: !!row.active,
    created_by: row.created_by,
    messages: row.messages,
    models: row.models,
    temperature: row.temperature,
    virtual_mcp_id: row.virtual_mcp_id,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}
```

- [ ] **Step 6: Simplify `TRIGGER_JOIN_AUTOMATION_COLUMNS` and `automationFromAliasedRow`**

Replace lines 209–265 with:

```typescript
// Shared between findActiveEventTriggers and findAllCronTriggers — both join
// `automations as a` and need the full automation row reconstructed from
// aliased columns. Keeping the alias list in one place means new automation
// columns only need updating here.
const TRIGGER_JOIN_AUTOMATION_COLUMNS = [
  "a.id as a_id",
  "a.organization_id as a_organization_id",
  "a.name as a_name",
  "a.active as a_active",
  "a.created_by as a_created_by",
  "a.messages as a_messages",
  "a.models as a_models",
  "a.temperature as a_temperature",
  "a.virtual_mcp_id as a_virtual_mcp_id",
  "a.created_at as a_created_at",
  "a.updated_at as a_updated_at",
] as const;

function automationFromAliasedRow(row: {
  a_id: string;
  a_organization_id: string;
  a_name: string;
  a_active: boolean | number;
  a_created_by: string;
  a_messages: string;
  a_models: string;
  a_temperature: number;
  a_virtual_mcp_id: string;
  a_created_at: Date | string;
  a_updated_at: Date | string;
}): Automation {
  return automationFromDbRow({
    id: row.a_id,
    organization_id: row.a_organization_id,
    name: row.a_name,
    active: row.a_active,
    created_by: row.a_created_by,
    messages: row.a_messages,
    models: row.a_models,
    temperature: row.a_temperature,
    virtual_mcp_id: row.a_virtual_mcp_id,
    created_at: row.a_created_at,
    updated_at: row.a_updated_at,
  });
}
```

- [ ] **Step 7: Simplify the `create` method**

Inside `KyselyAutomationsStorage.create` (lines 274–303), replace the `row` literal so it no longer includes `kind`/`connection_id`/`tool_name`/`tool_input`:

```typescript
  async create(input: CreateAutomationInput): Promise<Automation> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const row = {
      id,
      organization_id: input.organization_id,
      name: input.name,
      active: input.active ?? true,
      created_by: input.created_by,
      messages: input.messages,
      models: input.models,
      temperature: input.temperature ?? 0.5,
      virtual_mcp_id: input.virtual_mcp_id,
      created_at: now,
      updated_at: now,
    };

    const result = await this.db
      .insertInto("automations")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return automationFromDbRow(result);
  }
```

- [ ] **Step 8: Simplify `listWithTriggerCounts`**

In `listWithTriggerCounts` (lines 330–390), drop the four columns from both the SELECT and the GROUP BY:

Replace lines 337–353 (the inner `.select([...])` array) with:

```typescript
      .select([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.messages",
        "a.models",
        "a.temperature",
        "a.virtual_mcp_id",
        "a.created_at",
        "a.updated_at",
      ])
```

Replace lines 363–379 (the `.groupBy([...])`) with:

```typescript
      .groupBy([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.messages",
        "a.models",
        "a.temperature",
        "a.virtual_mcp_id",
        "a.created_at",
        "a.updated_at",
      ])
```

- [ ] **Step 9: Simplify the `update` method**

Replace `update` (lines 392–425) with:

```typescript
  async update(
    id: string,
    organizationId: string,
    input: UpdateAutomationInput,
  ): Promise<Automation> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updated_at: now };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.messages !== undefined) updateData.messages = input.messages;
    if (input.models !== undefined) updateData.models = input.models;
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;

    await this.db
      .updateTable("automations")
      .set(updateData)
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();

    const automation = await this.findById(id, organizationId);
    if (!automation) {
      throw new Error("Automation not found after update");
    }

    return automation;
  }
```

- [ ] **Step 10: Simplify `createAutomationRunThread` and delete `createToolCallRunThread`**

Replace lines 599–663 (both methods) with:

```typescript
  async createAutomationRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string> {
    const taskId = generatePrefixedId("thrd");
    const now = new Date().toISOString();
    await this.db
      .insertInto("threads")
      .values({
        id: taskId,
        organization_id: automation.organization_id,
        title: `Automation: ${automation.name}`,
        description: null,
        status: "in_progress",
        trigger_id: triggerId,
        virtual_mcp_id: automation.virtual_mcp_id,
        hidden: false,
        created_at: now,
        updated_at: now,
        created_by: automation.created_by,
        updated_by: null,
      })
      .execute();
    return taskId;
  }
```

The `virtual_mcp_id` null check is no longer needed — the type guarantees it.

- [ ] **Step 11: Commit**

```bash
git add apps/mesh/src/storage/automations.ts
git commit -m "refactor(automations): remove tool-call branches from storage adapter"
```

---

## Task 4: Strip tool-call branch from DBOS workflow

**Files:**
- Modify: `apps/mesh/src/automations/dbos-workflow.ts`

- [ ] **Step 1: Drop tool-call types and helpers**

Delete everything between the comment `// Tool-call branch (kind='tool_call')` block header and the `fireAutomationWorkflow` registration — that is, delete lines 419–663 (the entire `// ============================================================================ // Tool-call branch (kind='tool_call') // ============================================================================` section, including `ToolCallInvocation`, `createToolCallRunThreadStep`, `invokeFixedToolStep`, `persistToolCallResultStep`, and `runToolCallFire`).

- [ ] **Step 2: Simplify `PrepareOutcome`**

Replace lines 152–163 with:

```typescript
type PrepareOutcome =
  | { skip: "not_found" | "inactive" | "creator_invalid" }
  | {
      automation: Automation;
      resolvedModel: ResolvedAutomationModel;
    };
```

- [ ] **Step 3: Drop the tool_call branch in `prepareFireStep`**

In `prepareFireStep` (lines 165–235), delete lines 189–193 (the tool-call early return) entirely:

Remove this block:
```typescript
  // Tool-call automations skip tier resolution and model lookup entirely —
  // they invoke a fixed MCP tool with fixed args, no LLM involved.
  if (automation.kind === "tool_call") {
    return { automation, resolvedModel: null };
  }
```

The function now always proceeds to tier resolution.

- [ ] **Step 4: Drop the tool_call branch in `fireAutomationWorkflowFn`**

In `fireAutomationWorkflowFn` (lines 333–417), delete lines 341–353 (the `if (prep.automation.kind === "tool_call")` block):

Remove the comment block + branch:
```typescript
  // Tool-call automations skip the agent dispatch entirely: ...
  if (prep.automation.kind === "tool_call") {
    return await runToolCallFire(prep.automation, ctx.triggerId);
  }
```

Also remove the trailing `!` non-null assertion on `prep.resolvedModel` (now always defined) — change line 383 from `prep.resolvedModel!` to `prep.resolvedModel`, and delete the `// The agent branch in prepareFireStep ...` comment above it.

- [ ] **Step 5: Verify the file typechecks in isolation**

Run: `bun run --cwd apps/mesh check 2>&1 | head -40`

Expected: there may still be errors elsewhere in the repo, but `dbos-workflow.ts` itself should not be the source. Skim the output for the file's path. If it appears, fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/automations/dbos-workflow.ts
git commit -m "refactor(automations): drop tool-call branch from DBOS workflow"
```

---

## Task 5: Simplify AUTOMATION_CREATE tool

**Files:**
- Modify: `apps/mesh/src/tools/automations/create.ts`

- [ ] **Step 1: Replace the file**

Full file replacement:

```typescript
/**
 * AUTOMATION_CREATE Tool
 *
 * Creates a new automation that runs an agent thread on trigger fire.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { ChatTierSchema } from "../organization/schema";
import { normalizeMessages } from "./normalize-messages";

export const AUTOMATION_CREATE = defineTool({
  name: "AUTOMATION_CREATE",
  description:
    "Create an automation that runs an agent thread on trigger fire. Requires virtual_mcp_id + messages.",
  annotations: {
    title: "Create Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(255),
    virtual_mcp_id: z.string(),
    messages: z.union([
      z.string(),
      z.array(
        z.looseObject({
          id: z.string().optional(),
          role: z.enum(["user", "assistant", "system"]),
          parts: z.array(z.record(z.string(), z.unknown())),
          metadata: z.unknown().optional(),
        }),
      ),
    ]),
    models: z
      .object({
        tier: ChatTierSchema,
      })
      .loose()
      .default({ tier: "smart" }),
    temperature: z.number().default(0.5),
    active: z.boolean().default(true),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    created_at: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("Unable to determine user identity");
    }

    const normalizedMessages = normalizeMessages(input.messages);

    const automation = await ctx.storage.automations.create({
      organization_id: organization.id,
      created_by: userId,
      name: input.name,
      messages: JSON.stringify(normalizedMessages),
      models: JSON.stringify(input.models),
      temperature: input.temperature,
      active: input.active,
      virtual_mcp_id: input.virtual_mcp_id,
    });

    posthog.capture({
      distinctId: userId,
      event: "automation_created",
      groups: { organization: organization.id },
      properties: {
        organization_id: organization.id,
        automation_id: automation.id,
        virtual_mcp_id: input.virtual_mcp_id,
        active: automation.active,
        tier: input.models.tier,
      },
    });

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_at: automation.created_at,
    };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/mesh/src/tools/automations/create.ts
git commit -m "refactor(automations): simplify AUTOMATION_CREATE to agent-only"
```

---

## Task 6: Simplify AUTOMATION_UPDATE tool

**Files:**
- Modify: `apps/mesh/src/tools/automations/update.ts`

- [ ] **Step 1: Drop tool-call fields from the input schema**

Replace lines 27–56 (the `inputSchema`) with:

```typescript
  inputSchema: z.object({
    id: z.string(),
    name: z.string().min(1).max(255).optional(),
    active: z.boolean().optional(),
    messages: z
      .union([
        z.string(),
        z.array(
          z.looseObject({
            id: z.string().optional(),
            role: z.enum(["user", "assistant", "system"]),
            parts: z.array(z.record(z.string(), z.unknown())),
            metadata: z.unknown().optional(),
          }),
        ),
      ])
      .optional(),
    models: z
      .object({
        tier: ChatTierSchema,
      })
      .optional(),
    temperature: z.number().optional(),
  }),
```

- [ ] **Step 2: Drop tool-call update logic from the handler**

In the handler body (lines 77–120), remove the tool-call update block. After Step 1 edits, the handler's update-data assembly should look like:

```typescript
    // Build update payload
    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.messages !== undefined) {
      const normalizedMessages = normalizeMessages(input.messages);
      updateData.messages = JSON.stringify(normalizedMessages);
    }
    if (input.models !== undefined)
      updateData.models = JSON.stringify(input.models);
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    const automation = await ctx.storage.automations.update(
      input.id,
      organization.id,
      updateData,
    );
```

The entire `if (input.connection_id !== undefined || ...)` block (original lines 89–120) is deleted.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/tools/automations/update.ts
git commit -m "refactor(automations): drop tool-call updates from AUTOMATION_UPDATE"
```

---

## Task 7: Simplify AUTOMATION_GET and AUTOMATION_LIST output schemas

**Files:**
- Modify: `apps/mesh/src/tools/automations/get.ts`
- Modify: `apps/mesh/src/tools/automations/list.ts`

- [ ] **Step 1: Edit `get.ts`**

Replace lines 24–56 (the `outputSchema`) with:

```typescript
  outputSchema: z.object({
    automation: z
      .object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        created_by: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        virtual_mcp_id: z.string(),
        messages: z.unknown(),
        models: z.unknown(),
        temperature: z.number(),
        triggers: z.array(
          z.object({
            id: z.string(),
            type: z.enum(["cron", "event", "webhook"]),
            cron_expression: z.string().nullable(),
            connection_id: z.string().nullable(),
            event_type: z.string().nullable(),
            params: z.unknown().nullable(),
            last_run_at: z.string().nullable(),
            api_key_id: z.string().nullable(),
            created_at: z.string(),
          }),
        ),
      })
      .nullable(),
  }),
```

Then replace the returned object in the handler (lines 73–103) with:

```typescript
    return {
      automation: {
        id: automation.id,
        name: automation.name,
        active: automation.active,
        created_by: automation.created_by,
        created_at: automation.created_at,
        updated_at: automation.updated_at,
        virtual_mcp_id: automation.virtual_mcp_id,
        messages: JSON.parse(automation.messages),
        models: JSON.parse(automation.models),
        temperature: automation.temperature,
        triggers: triggers.map((t) => ({
          id: t.id,
          type: t.type,
          cron_expression: t.cron_expression,
          connection_id: t.connection_id,
          event_type: t.event_type,
          params: t.params ? JSON.parse(t.params) : null,
          last_run_at: t.last_run_at,
          api_key_id: t.api_key_id,
          created_at: t.created_at,
        })),
      },
    };
```

- [ ] **Step 2: Edit `list.ts`**

Replace lines 25–41 (the `outputSchema`) with:

```typescript
  outputSchema: z.object({
    automations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        created_by: z.string(),
        created_at: z.string(),
        trigger_count: z.number(),
        nearest_next_run_at: z.string().nullable(),
        virtual_mcp_id: z.string(),
      }),
    ),
  }),
```

Replace the handler's `results` map (lines 52–64) with:

```typescript
    const results = automations.map((automation) => ({
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_by: automation.created_by,
      created_at: automation.created_at,
      trigger_count: automation.trigger_count,
      nearest_next_run_at: automation.nearest_next_run_at,
      virtual_mcp_id: automation.virtual_mcp_id,
    }));
```

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/tools/automations/get.ts apps/mesh/src/tools/automations/list.ts
git commit -m "refactor(automations): drop tool-call fields from GET/LIST schemas"
```

---

## Task 8: Update frontend type definitions and helpers

**Files:**
- Modify: `apps/mesh/src/web/hooks/use-automations.ts`

- [ ] **Step 1: Simplify `AutomationListItem`**

Replace lines 110–124 with:

```typescript
export interface AutomationListItem {
  id: string;
  name: string;
  active: boolean;
  created_by: string;
  created_at: string;
  trigger_count: number;
  virtual_mcp_id: string;
  nearest_next_run_at: string | null;
}
```

- [ ] **Step 2: Simplify `AutomationDetail`**

Replace lines 139–158 with:

```typescript
export interface AutomationDetail {
  id: string;
  name: string;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  virtual_mcp_id: string;
  messages: unknown[];
  models: {
    tier?: "fast" | "smart" | "thinking";
    [key: string]: unknown;
  };
  temperature: number;
  triggers: AutomationTrigger[];
}
```

- [ ] **Step 3: Delete `buildDefaultToolCallAutomationInput`**

Replace lines 234–245 (the entire `buildDefaultToolCallAutomationInput` function) with nothing — remove the function and its leading blank line.

After this, only `buildDefaultAutomationInput` (lines 223–232) remains in the Helpers section.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/hooks/use-automations.ts
git commit -m "refactor(automations): drop tool-call fields from frontend types"
```

---

## Task 9: Simplify the automations list view (per-agent)

**Files:**
- Modify: `apps/mesh/src/web/views/automations/automations-list.tsx`

- [ ] **Step 1: Replace the file**

```typescript
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Zap } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import {
  buildDefaultAutomationInput,
  useAutomationActions,
  useAutomations,
} from "@/web/hooks/use-automations";
import { AutomationListRow } from "./automation-list-row";
import { track } from "@/web/lib/posthog-client";

export function AutomationsList({ virtualMcpId }: { virtualMcpId: string }) {
  const navigate = useNavigate();
  const { data: automations = [] } = useAutomations(virtualMcpId);
  const { create } = useAutomationActions();
  const [search, setSearch] = useState("");

  const lowerSearch = search.toLowerCase();
  const filtered = automations.filter((a) =>
    a.name.toLowerCase().includes(lowerSearch),
  );

  const goToDetail = (id: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: "automation:" + id,
      }),
      replace: true,
    });

  const handleNew = async () => {
    if (create.isPending) return;
    track("automation_new_clicked", {
      virtual_mcp_id: virtualMcpId,
      existing_count: automations.length,
    });
    const created = await create.mutateAsync(
      buildDefaultAutomationInput(virtualMcpId),
    );
    goToDetail(created.id);
  };

  const newButton = (
    <Button size="sm" onClick={handleNew} disabled={create.isPending}>
      <Plus size={14} />
      New automation
    </Button>
  );

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Automations</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {automations.length > 0 && (
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search automations..."
                  className="w-full md:w-[375px]"
                />
              )}
              {newButton}
            </div>
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations yet"
                description="Create your first automation to run this agent on a schedule or in response to events."
                actions={newButton}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations found"
                description={`No automations match "${search}"`}
              />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-border overflow-hidden">
              {filtered.map((a) => (
                <AutomationListRow
                  key={a.id}
                  automation={a}
                  onClick={() => goToDetail(a.id)}
                />
              ))}
            </div>
          )}
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mesh/src/web/views/automations/automations-list.tsx
git commit -m "refactor(automations): drop tool-call entry from per-agent list"
```

---

## Task 10: Simplify automation list row

**Files:**
- Modify: `apps/mesh/src/web/views/automations/automation-list-row.tsx`

- [ ] **Step 1: Replace lines 1–27 (imports) with**

```typescript
import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Clock, DotsVertical, Trash01, Zap } from "@untitledui/icons";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  useAutomationActions,
  type AutomationListItem,
} from "@/web/hooks/use-automations";
```

`Tool02` is removed from the icon import list.

- [ ] **Step 2: Replace lines 28–55 (component header) with**

```typescript
export function AutomationListRow({
  automation,
  showAgent,
  onClick,
}: {
  automation: AutomationListItem;
  showAgent?: boolean;
  onClick: () => void;
}) {
  const { remove } = useAutomationActions();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const agent = useVirtualMCP(
    showAgent ? automation.virtual_mcp_id : undefined,
  );

  const handleDelete = () => {
    remove.mutate(automation.id);
    setConfirmOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };
```

- [ ] **Step 3: Replace lines 82–113 (the avatar + label conditional) with**

```typescript
        {showAgent && (
          <AgentAvatar
            icon={agent?.icon ?? null}
            name={agent?.title ?? automation.name}
            size="xs"
            className="shrink-0"
          />
        )}

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {automation.name}
            </span>
            {showAgent && agent && (
              <span className="text-xs text-muted-foreground truncate">
                · {agent.title}
              </span>
            )}
          </div>
          <TriggerSummary
            triggerCount={automation.trigger_count}
            nextRunAt={automation.nearest_next_run_at}
          />
        </div>
```

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/views/automations/automation-list-row.tsx
git commit -m "refactor(automations): drop tool-call rendering from list row"
```

---

## Task 11: Simplify automation tab navigation

**Files:**
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/automation-tab.tsx`

- [ ] **Step 1: Replace `AutomationTabInner`**

Replace lines 36–86 with:

```typescript
function AutomationTabInner({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data: automation, isLoading } = useAutomation(id);

  const onBack = () => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: "automations",
      }),
      replace: true,
    });
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Automation not found
      </div>
    );
  }

  return (
    <AutomationInlineDetail
      automationId={id}
      automation={automation}
      onBack={onBack}
    />
  );
}
```

- [ ] **Step 2: Remove the now-unused `useProjectContext` import**

The new function no longer references `org` / `useProjectContext`. Edit the imports section (lines 1–8):

```typescript
import { parseAutomationTabId } from "./tab-id";
import { SettingsTab as AutomationInlineDetail } from "@/web/views/automations/automation-detail";
import { useAutomation } from "@/web/hooks/use-automations";
import { Page } from "@/web/components/page";
import { Loading01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
```

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/layouts/main-panel-tabs/automation-tab.tsx
git commit -m "refactor(automations): drop tool-call back navigation"
```

---

## Task 12: Strip tool-call branches from automation detail page

**Files:**
- Modify: `apps/mesh/src/web/views/automations/automation-detail.tsx`
- Delete: `apps/mesh/src/web/views/automations/tool-call-config-fields.tsx`

This is the largest UI change. Most of it is straight-line deletion.

- [ ] **Step 1: Remove the `ToolCallConfigFields` import**

Delete lines 66–69:

```typescript
import {
  ToolCallConfigFields,
  type ToolCallConfigValue,
} from "./tool-call-config-fields";
```

- [ ] **Step 2: Delete tool-call config state**

In the `SettingsTab` component body (around lines 374–384), remove the entire `toolCallConfig` declaration:

Delete:
```typescript
  // Tool-call config (only meaningful for kind='tool_call' automations).
  // Tracked outside RHF because the field set is different from the agent
  // form and the schema-driven input shape doesn't compose with RHF's
  // flat field map.
  const [toolCallConfig, setToolCallConfig] = useState<ToolCallConfigValue>(
    () => ({
      connectionId: automation.connection_id ?? "",
      toolName: automation.tool_name ?? "",
      input: (automation.tool_input as Record<string, unknown> | null) ?? {},
    }),
  );
```

- [ ] **Step 3: Delete the tool-call autosave hook**

Remove the entire tool-call autosave block (around lines 509–555). Delete:

```typescript
  // Tool-call autosave bypasses the global `update` mutation hook because
  // that hook toasts on every success — fine for a deliberate save but
  // noisy when the user is just typing in the JSON input. We call the
  // MCP tool directly here and silently invalidate the affected query
  // keys; toasts only fire on the explicit Test action.
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const saveToolCallConfig = async (
    next: ToolCallConfigValue,
  ): Promise<boolean> => {
    if (automation.kind !== "tool_call") return true;
    try {
      const result = (await selfClient.callTool({
        name: "AUTOMATION_UPDATE",
        arguments: {
          id: automationId,
          connection_id: next.connectionId,
          tool_name: next.toolName,
          tool_input: next.input,
        },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      if (result.isError) {
        toast.error(
          result.content?.[0]?.text ?? "Failed to save tool-call config",
        );
        return false;
      }
      queryClient.invalidateQueries({ queryKey: KEYS.automationsAll(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.automation(org.id, automationId),
      });
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save tool-call config",
      );
      return false;
    }
  };
  const { schedule: scheduleToolCallSave, flush: flushToolCallSave } =
    useDebouncedAutosave({
      save: () => saveToolCallConfig(toolCallConfig),
    });
```

- [ ] **Step 4: Remove now-unused imports**

After Step 3, the file no longer references `useMCPClient`, `SELF_MCP_ALIAS_ID`, `useQueryClient`, or `KEYS`. Edit the import section (lines 33–41):

Drop `SELF_MCP_ALIAS_ID` and `useMCPClient` from `@decocms/mesh-sdk` if no other use exists. Drop `useQueryClient` import (lines 39). Drop the `KEYS` import (line 40). After editing the relevant lines should read:

```typescript
import { useProjectContext } from "@decocms/mesh-sdk";
```

(keeping only `useProjectContext` since `org` is still used elsewhere). Inspect the resulting file with `grep -n "SELF_MCP_ALIAS_ID\|useMCPClient\|useQueryClient\|KEYS\." apps/mesh/src/web/views/automations/automation-detail.tsx` and remove any imports that no longer match any usage.

- [ ] **Step 5: Simplify the `kind` analytics field in `handleRunClick`**

In `handleRunClick` (around line 588), drop the `kind:` field and the tool-call branch:

Replace:

```typescript
  const handleRunClick = async () => {
    track("automation_test_clicked", {
      automation_id: automationId,
      agent_id: agentId,
      kind: automation.kind,
    });

    if (automation.kind === "tool_call") {
      // ...
      const saved = await flushToolCallSave();
      if (!saved) return;
      try {
        await runMutation.mutateAsync(automationId);
      } catch {
        // ...
      }
      return;
    }

    const saved = await flushAndSave();
    forceSessionFlush();
    if (!saved) return;
    // ...
```

with:

```typescript
  const handleRunClick = async () => {
    track("automation_test_clicked", {
      automation_id: automationId,
      agent_id: agentId,
    });

    const saved = await flushAndSave();
    forceSessionFlush();
    if (!saved) return;

    if (!tiptapDoc) {
      toast.error("No instructions configured for this automation");
      return;
    }

    setSimpleModeTier(form.getValues("tier"));

    setChatOpen(true);
    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    createTaskWithMessage({
      message: { tiptapDoc, parts },
      virtualMcpId: agentId || undefined,
    });
  };
```

- [ ] **Step 6: Simplify the "Back to list" button**

Around lines 638–641, replace:

```typescript
            <ArrowLeft size={14} />
            {automation.kind === "tool_call"
              ? "Back to all automations"
              : "Back to list"}
          </Button>
```

with:

```typescript
            <ArrowLeft size={14} />
            Back to list
          </Button>
```

- [ ] **Step 7: Replace the tool-call vs agent rendering branch with the agent-only branch**

The block at lines 855–945 — the big `automation.kind === "tool_call" ? (<tool-call markup>) : (<agent markup>)` — must become just the agent markup. Replace lines 855–945 with:

```typescript
        {/* Section: Instructions */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground/60">
              Instructions
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={isImproving || !tiptapDoc}
              onClick={handleImprovePrompt}
            >
              <Stars01 size={13} />
              Improve
            </Button>
          </div>
          <TiptapProvider
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            placeholder="What should this automation do?"
          >
            <div className="rounded-xl border border-border min-h-[120px] flex flex-col">
              <TiptapInput
                virtualMcpId={agentId || null}
                className="max-h-[45vh]"
              />

              <div className="@container/chat-bottom flex items-center justify-end gap-1.5 p-2.5">
                <SimpleModeTierDropdown
                  tier={form.watch("tier")}
                  onSelect={(tier) =>
                    form.setValue("tier", tier, { shouldDirty: true })
                  }
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="default"
                      className="h-8 gap-1.5 rounded-md px-3 text-sm font-medium"
                      onClick={handleRunClick}
                      disabled={!agentId}
                    >
                      <ArrowUp size={16} />
                      Test
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Test Automation</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TiptapProvider>
        </div>
```

- [ ] **Step 8: Delete `tool-call-config-fields.tsx`**

```bash
rm apps/mesh/src/web/views/automations/tool-call-config-fields.tsx
```

- [ ] **Step 9: Typecheck this file**

Run: `bun run --cwd apps/mesh check 2>&1 | grep "automation-detail.tsx" | head -20`

Expected: no errors specific to this file. If anything remains, fix it (most likely an unused import or a leftover `automation.kind` reference).

- [ ] **Step 10: Commit**

```bash
git add apps/mesh/src/web/views/automations/automation-detail.tsx apps/mesh/src/web/views/automations/tool-call-config-fields.tsx
git commit -m "refactor(automations): strip tool-call branches from detail page"
```

---

## Task 13: Strip tool_call_run from task panel

**Files:**
- Modify: `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx`
- Modify: `apps/mesh/src/web/layouts/tasks-panel/mcp-avatar.tsx`

- [ ] **Step 1: Edit `task-row.tsx`**

Replace lines 1–14 (imports + start of function) with:

```typescript
import { cn } from "@deco/ui/lib/utils.js";
import { Archive } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { McpAvatar } from "./mcp-avatar";
import { getStatusConfig } from "@/web/lib/task-status";
import { formatTimeAgo } from "@/web/lib/format-time";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { isSyntheticBranch } from "@/shared/is-synthetic-branch";
import { useClockTick } from "@/web/lib/use-clock-tick";
import type { Task } from "@/web/components/chat/task/types";
```

(`ToolCallRunAvatar` removed from the `./mcp-avatar` import.)

Replace lines 30–44 (the body header) with:

```typescript
  const config = getStatusConfig(task.status);
  const StatusIcon = config.icon;
  const virtualMcp = useVirtualMCP(task.virtual_mcp_id);
  const githubRepo = getActiveGithubRepo(virtualMcp);
  // Subscribe to a 60s heartbeat so the relative timestamp re-renders even
  // when `task` is referentially stable.
  useClockTick(60_000);
```

(The `isToolCallRun` const is removed; the comment block above it is removed; `useVirtualMCP` is called unconditionally with `task.virtual_mcp_id`.)

Replace lines 70–81 (the avatar conditional) with:

```typescript
      <McpAvatar
        virtualMcpId={task.virtual_mcp_id}
        size="xs"
        showAutomationBadge={showAutomationBadge}
      />
```

- [ ] **Step 2: Edit `mcp-avatar.tsx` — delete `ToolCallRunAvatar`**

Replace the entire file with:

```typescript
import { AgentAvatar } from "@/web/components/agent-icon";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { Zap } from "@untitledui/icons";

/**
 * Resolves a virtualMCP by id and renders its avatar.
 * React Query deduplicates the fetch across rows.
 */
export function McpAvatar({
  virtualMcpId,
  size = "sm",
  showAutomationBadge,
}: {
  virtualMcpId: string | null | undefined;
  size?: "xs" | "sm" | "md";
  showAutomationBadge?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      {virtualMcpId ? (
        <McpAvatarInner virtualMcpId={virtualMcpId} size={size} />
      ) : (
        <AgentAvatar icon={null} name="?" size={size} />
      )}
      {showAutomationBadge && (
        <span
          aria-label="Automation-triggered"
          className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-blue-500 border border-blue-600 text-white"
        >
          <Zap size={10} className="text-white" />
        </span>
      )}
    </div>
  );
}

function McpAvatarInner({
  virtualMcpId,
  size,
}: {
  virtualMcpId: string;
  size: "xs" | "sm" | "md";
}) {
  const entity = useVirtualMCP(virtualMcpId);
  if (!entity) return <AgentAvatar icon={null} name="?" size={size} />;
  return (
    <AgentAvatar icon={entity.icon ?? null} name={entity.title} size={size} />
  );
}
```

(`Tool02` and the `cn` import are no longer needed; `ToolCallRunAvatar` is gone.)

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/layouts/tasks-panel/task-row.tsx apps/mesh/src/web/layouts/tasks-panel/mcp-avatar.tsx
git commit -m "refactor(automations): drop tool_call_run rendering from task panel"
```

---

## Task 14: Drop tool-call entry from org-scoped settings

**Files:**
- Modify: `apps/mesh/src/web/routes/orgs/settings/automations.tsx`

- [ ] **Step 1: Replace the file**

```typescript
import { useState } from "react";
import { Plus, Zap } from "@untitledui/icons";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useAutomations } from "@/web/hooks/use-automations";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AutomationListRow } from "@/web/views/automations/automation-list-row";
import {
  getDecopilotId,
  useVirtualMCPs,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { track } from "@/web/lib/posthog-client";

export default function SettingsAutomationsPage() {
  const { org } = useProjectContext();
  const { data: automations = [] } = useAutomations(undefined);
  const agents = useVirtualMCPs();
  const navigateToAgent = useNavigateToAgent();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const lowerSearch = search.toLowerCase();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const filtered = automations.filter((a) => {
    if (!lowerSearch) return true;
    if (a.name.toLowerCase().includes(lowerSearch)) return true;
    if (a.virtual_mcp_id) {
      const agent = agentMap.get(a.virtual_mcp_id);
      if (agent && agent.title.toLowerCase().includes(lowerSearch)) return true;
    }
    return false;
  });

  const handleRowClick = (automationId: string, agentId: string | null) => {
    // Agent-kind rows whose virtual_mcp_id no longer resolves are orphaned;
    // fall back to Decopilot so the detail panel still has a host shell.
    const target =
      agentId && agentMap.has(agentId) ? agentId : getDecopilotId(org.id);
    track("automations_list_row_clicked", {
      automation_id: automationId,
      agent_id: target,
      source: "settings_automations",
    });
    navigateToAgent(target, {
      search: { main: "automation:" + automationId },
    });
  };

  const handleBrowseAgents = () => {
    track("automations_empty_state_browse_agents_clicked");
    navigate({ to: "/$org/settings/agents", params: { org: org.slug } });
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Automations</Page.Title>
            {automations.length > 0 && (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search automations..."
                className="w-full md:w-[375px]"
              />
            )}
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations yet"
                description="Automations are created per agent. Open an agent and add one from its Automations tab."
                actions={
                  <Button size="sm" onClick={handleBrowseAgents}>
                    <Plus size={14} />
                    Browse agents
                  </Button>
                }
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations found"
                description={`No automations match "${search}"`}
              />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-border overflow-hidden">
              {filtered.map((a) => (
                <AutomationListRow
                  key={a.id}
                  automation={a}
                  showAgent
                  onClick={() => handleRowClick(a.id, a.virtual_mcp_id)}
                />
              ))}
            </div>
          )}
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/settings/automations.tsx
git commit -m "refactor(automations): drop tool-call entry from org settings page"
```

---

## Task 15: Update test fixtures

**Files:**
- Modify: `apps/mesh/src/automations/automation-event-dispatcher.test.ts`

- [ ] **Step 1: Replace lines 16–37 (the `makeAutomation` helper) with**

```typescript
function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto_1",
    organization_id: ORG_ID,
    name: "Test",
    active: true,
    created_by: USER_ID,
    messages: JSON.stringify([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ]),
    models: JSON.stringify({ tier: "smart" }),
    temperature: 0.5,
    virtual_mcp_id: "agent_1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
```

- [ ] **Step 2: Run the test**

Run: `bun test apps/mesh/src/automations/automation-event-dispatcher.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/automations/automation-event-dispatcher.test.ts
git commit -m "test(automations): drop tool-call fields from test fixture"
```

---

## Task 16: Update doc comments in mesh-sdk

**Files:**
- Modify: `packages/mesh-sdk/src/types/decopilot-events.ts`

This is a cosmetic cleanup so the comment doesn't reference a kind that no longer exists.

- [ ] **Step 1: Read context**

Run: `sed -n '80,95p' packages/mesh-sdk/src/types/decopilot-events.ts`

- [ ] **Step 2: Rewrite the comment**

Find the doc comment that mentions `tool_call_run` (around lines 84–87 per earlier grep):

```typescript
    /** Free-form thread metadata snapshot. The chat UI keys off
     *  metadata.kind to switch between agent-thread and tool_call_run
     *  renderings (avatar, message-renderer), so the workflow that
     *  spawns those threads must include it on the first event or the
     *  row renders with the wrong icon until a refetch. */
```

Replace with:

```typescript
    /** Free-form thread metadata snapshot. Carried through so the chat
     *  UI can match the row's appearance to whatever the workflow stamps
     *  on the thread (icon, message renderer). */
```

- [ ] **Step 3: Commit**

```bash
git add packages/mesh-sdk/src/types/decopilot-events.ts
git commit -m "docs(mesh-sdk): drop stale tool_call_run reference from event type"
```

---

## Task 17: Final sweep + verification

**Files:**
- (none — verification + migration apply)

- [ ] **Step 1: Repo-wide grep for stragglers**

Run each of these and confirm zero matches in `apps/mesh/src/`, `packages/mesh-sdk/src/`:

```bash
rg -n "AutomationKind|kind: ['\"]tool_call['\"]|kind === ['\"]tool_call['\"]|tool_call_run|isToolCall|ToolCallRunAvatar|ToolCallConfigFields|ToolCallConfigValue|buildDefaultToolCallAutomationInput|createToolCallRunThread|invokeFixedToolStep|persistToolCallResultStep|runToolCallFire" apps/mesh/src/ packages/mesh-sdk/src/
```

Expected: no matches. (Hits in `apps/mesh/migrations/078-automation-tool-call-kind.ts` and `apps/mesh/migrations/082-remove-automation-tool-call-kind.ts` are fine — they document the schema lifecycle. Hits inside other unrelated chat tool-call code paths — e.g. `tool-call-part/`, `isToolCallsWaitingOnClient` — should NOT be touched.)

If anything appears, fix and re-run.

- [ ] **Step 2: Typecheck**

Run: `bun run check`

Expected: clean exit.

- [ ] **Step 3: Lint**

Run: `bun run lint`

Expected: clean exit.

- [ ] **Step 4: Format**

Run: `bun run fmt`

Stage any whitespace-only diffs.

- [ ] **Step 5: Apply the migration locally**

Start dev server if not already running (`bun run dev` from repo root) and run:

```bash
bun run --cwd=apps/mesh migrate
```

Expected: migration 095 applies cleanly. If a local DB already has automations rows, any with `kind='tool_call'` are deleted.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`

Expected: all tests pass.

- [ ] **Step 7: Manual UI smoke**

With dev server running:

1. Navigate to an agent's Automations tab — confirm the "New automation" button is a single button (no dropdown).
2. Click it — confirm a new automation is created and the detail page opens with the instructions editor (no tool-call config card).
3. Save a change — confirm the autosave still works.
4. Open the org-scoped automations list (`/$org/settings/automations`) — confirm there's no "New tool-call automation" button.
5. Open the tasks panel — confirm regular task rows still render their agent avatars.

- [ ] **Step 8: Commit any format-only changes**

```bash
git add -A
git diff --cached --stat
# If only whitespace remains:
git commit -m "[chore]: format after tool-call automation removal"
```

If the diff is empty after format, skip the commit.

- [ ] **Step 9: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "refactor(automations): remove tool-call automation kind" --body "$(cat <<'EOF'
## Summary
- Drop the `kind = "tool_call"` execution mode for automations (introduced in migration 078).
- Migration 095 deletes `kind='tool_call'` rows, drops the four conditional columns, restores `virtual_mcp_id NOT NULL`, and removes the three CHECK constraints.
- Strips every tool-call branch from storage, the DBOS workflow, the MCP tools, the per-agent + org-scoped UI lists, the automation detail page (no more dual rendering), and the task panel.
- Deletes `tool-call-config-fields.tsx`.

Spec: `docs/superpowers/specs/2026-05-26-remove-tool-call-automation-kind-design.md`

## Test plan
- [ ] `bun run check` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] Migration 095 applies cleanly against a local DB with a synthetic tool_call row
- [ ] Manual smoke: per-agent + org-scoped automations lists each show a single "New automation" button; detail page surfaces the instructions editor only

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
