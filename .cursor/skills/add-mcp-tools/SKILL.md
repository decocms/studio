---
name: add-mcp-tools
description: Guide for adding new MCP tools with consistent patterns for schemas, tool definitions, registry updates, and Better Auth integration
---

# Adding New MCP Tools to Studio

This guide documents the pattern for adding new MCP tools to Studio codebase. Follow this checklist to ensure consistency with existing tools.

## Overview

MCP tools are exposed via the Model Context Protocol and allow programmatic management of resources. Each tool follows a consistent pattern with:
- Zod schemas for input/output validation
- `defineTool` for automatic tracing, metrics, and audit logging
- Access control via `ctx.access.check()`
- Better Auth integration via `ctx.boundAuth`

## File Structure

When adding a new domain of tools (e.g., `apiKeys`, `webhooks`, `secrets`), create the following structure:

```
apps/mesh/src/tools/<domain>/
├── schema.ts     # Zod schemas for entities and operations
├── create.ts     # <DOMAIN>_CREATE tool
├── list.ts       # <DOMAIN>_LIST tool
├── update.ts     # <DOMAIN>_UPDATE tool  
├── delete.ts     # <DOMAIN>_DELETE tool
└── index.ts      # Barrel export
```

## Step-by-Step Checklist

### 1. Create Schema File (`schema.ts`)

Define Zod schemas for:
- **Entity schema**: The resource returned in list/get operations
- **Create input/output schemas**: Input for creation, output includes created entity
- **Update input/output schemas**: Partial updates
- **Delete input/output schemas**: ID input, success confirmation output

```typescript
// apps/mesh/src/tools/<domain>/schema.ts
import { z } from "zod";

// Entity schema (what's returned in list operations)
export const MyEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  // ... other fields
  createdAt: z.union([z.string(), z.date()]),
});

export type MyEntity = z.infer<typeof MyEntitySchema>;

// Create schemas
export const MyCreateInputSchema = z.object({
  name: z.string().min(1).max(255),
  // ... other fields
});

export const MyCreateOutputSchema = z.object({
  item: MyEntitySchema,
});

// List schemas
export const MyListInputSchema = z.object({
  // pagination, filters, etc.
});

export const MyListOutputSchema = z.object({
  items: z.array(MyEntitySchema),
});

// Update schemas
export const MyUpdateInputSchema = z.object({
  id: z.string(),
  // ... partial fields
});

export const MyUpdateOutputSchema = z.object({
  item: MyEntitySchema,
});

// Delete schemas
export const MyDeleteInputSchema = z.object({
  id: z.string(),
});

export const MyDeleteOutputSchema = z.object({
  success: z.boolean(),
  id: z.string(),
});
```

### 2. Create Tool Files

Each tool file follows this pattern:

```typescript
// apps/mesh/src/tools/<domain>/create.ts
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth, requireOrganization } from "../../core/mesh-context";
import { MyCreateInputSchema, MyCreateOutputSchema } from "./schema";

export const MY_DOMAIN_CREATE = defineTool({
  name: "MY_DOMAIN_CREATE",
  description: "Create a new resource",

  inputSchema: MyCreateInputSchema,
  outputSchema: MyCreateOutputSchema,

  handler: async (input, ctx) => {
    // 1. Require authentication
    requireAuth(ctx);
    
    // 2. Require organization (if org-scoped)
    const organization = requireOrganization(ctx);
    
    // 3. Check authorization
    await ctx.access.check();
    
    // 4. Get user ID
    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required");
    }
    
    // 5. Perform operation
    // Option A: Use ctx.boundAuth for Better Auth operations
    const result = await ctx.boundAuth.myDomain.create({ ... });
    
    // Option B: Use ctx.storage for custom storage operations
    const result = await ctx.storage.myDomain.create({ ... });
    
    // 6. Return result
    return { item: result };
  },
});
```

### 3. Create Barrel Export (`index.ts`)

```typescript
// apps/mesh/src/tools/<domain>/index.ts
export { MY_DOMAIN_CREATE } from "./create";
export { MY_DOMAIN_LIST } from "./list";
export { MY_DOMAIN_UPDATE } from "./update";
export { MY_DOMAIN_DELETE } from "./delete";

// Export schemas for external use
export * from "./schema";
```

### 4. Update Tool Registry (`registry.ts`)

Add tool names and metadata:

```typescript
// apps/mesh/src/tools/registry.ts

// 1. Add to ToolCategory type (if new category)
export type ToolCategory = "Organizations" | "Connections" | "My Domain";

// 2. Add to ALL_TOOL_NAMES array
const ALL_TOOL_NAMES = [
  // ... existing tools
  "MY_DOMAIN_CREATE",
  "MY_DOMAIN_LIST",
  "MY_DOMAIN_UPDATE",
  "MY_DOMAIN_DELETE",
] as const;

// 3. Add to MANAGEMENT_TOOLS array
export const MANAGEMENT_TOOLS: ToolMetadata[] = [
  // ... existing tools
  {
    name: "MY_DOMAIN_CREATE",
    description: "Create resource",
    category: "My Domain",
  },
  {
    name: "MY_DOMAIN_LIST",
    description: "List resources",
    category: "My Domain",
  },
  {
    name: "MY_DOMAIN_UPDATE",
    description: "Update resource",
    category: "My Domain",
  },
  {
    name: "MY_DOMAIN_DELETE",
    description: "Delete resource",
    category: "My Domain",
    dangerous: true,
  },
];

// 4. Add to TOOL_LABELS
const TOOL_LABELS: Record<ToolName, string> = {
  // ... existing labels
  MY_DOMAIN_CREATE: "Create resource",
  MY_DOMAIN_LIST: "List resources",
  MY_DOMAIN_UPDATE: "Update resource",
  MY_DOMAIN_DELETE: "Delete resource",
};

// 5. Update getToolsByCategory if new category
export function getToolsByCategory() {
  const grouped: Record<string, ToolMetadata[]> = {
    Organizations: [],
    Connections: [],
    "My Domain": [], // Add new category
  };
  // ...
}
```

### 5. Register Tools (`tools/index.ts`)

```typescript
// apps/mesh/src/tools/index.ts
import * as MyDomainTools from "./myDomain";

export { MyDomainTools };

export const ALL_TOOLS = [
  // ... existing tools
  MyDomainTools.MY_DOMAIN_CREATE,
  MyDomainTools.MY_DOMAIN_LIST,
  MyDomainTools.MY_DOMAIN_UPDATE,
  MyDomainTools.MY_DOMAIN_DELETE,
] as const satisfies { name: ToolName }[];
```

### 6. Add to Default Permissions (if needed)

```typescript
// apps/mesh/src/auth/index.ts
apiKey({
  permissions: {
    defaultPermissions: {
      self: [
        // ... existing permissions
        "MY_DOMAIN_LIST", // Read access by default
        // Note: CREATE, UPDATE, DELETE usually NOT default
      ],
    },
  },
}),
```

### 7. Add Better Auth Integration (if wrapping Better Auth API)

If your tools wrap Better Auth APIs, you need to:

**a. Add types to `mesh-context.ts`:**

```typescript
// apps/mesh/src/core/mesh-context.ts

// Add return types
export type MyDomainCreateResult = Awaited<
  ReturnType<BetterAuthApi["createMyDomain"]>
>;
// ... other types

// Add to BoundAuthClient interface
export interface BoundAuthClient {
  // ... existing methods
  
  myDomain: {
    create(data: { ... }): Promise<MyDomainCreateResult>;
    list(): Promise<MyDomainListResult>;
    update(data: { ... }): Promise<MyDomainUpdateResult>;
    delete(id: string): Promise<void>;
  };
}
```

**b. Implement in `context-factory.ts`:**

```typescript
// apps/mesh/src/core/context-factory.ts
function createBoundAuthClient(ctx: AuthContext): BoundAuthClient {
  return {
    // ... existing implementations
    
    myDomain: {
      create: async (data) => {
        return auth.api.createMyDomain({ headers, body: data });
      },
      list: async () => {
        return auth.api.listMyDomain({ headers });
      },
      update: async (data) => {
        return auth.api.updateMyDomain({ headers, body: data });
      },
      delete: async (id) => {
        await auth.api.deleteMyDomain({ headers, body: { id } });
      },
    },
  };
}
```

### 8. Document in Spec

Add documentation to `apps/mesh/spec/001.md`:

```markdown
#### My Domain Management

Description of what this domain manages.

**MY_DOMAIN_CREATE**

\`\`\`typescript
// Create example
POST /mcp/tools/MY_DOMAIN_CREATE
{ "name": "Example" }
// Response
{ "item": { "id": "...", "name": "Example", ... } }
\`\`\`

// ... other tools
```

## Key Patterns to Follow

### Authentication & Authorization

```typescript
// Always in this order:
requireAuth(ctx);                    // 1. Must be authenticated
const org = requireOrganization(ctx); // 2. Must have org context (if org-scoped)
await ctx.access.check();            // 3. Must have permission for this tool
```

### Error Handling

```typescript
// Throw descriptive errors
if (!result) {
  throw new Error(`Resource not found: ${id}`);
}

if (result.organizationId !== organization.id) {
  throw new Error("Resource not found in organization");
}
```

### Sensitive Data

For sensitive data (like API key values):

```typescript
// Only return sensitive data at creation time
export const CreateOutputSchema = z.object({
  id: z.string(),
  secretValue: z.string(), // Only here!
});

// Never return in list/get
export const EntitySchema = z.object({
  id: z.string(),
  // NO secretValue field
});
```

## Testing

Create test files alongside tool files:

```
apps/mesh/src/tools/<domain>/
├── create.test.ts
├── list.test.ts
├── update.test.ts
└── delete.test.ts
```

Use the existing test patterns from `apps/mesh/src/tools/connection/` as reference.

## Common Mistakes to Avoid

1. **Forgetting `await ctx.access.check()`** - Always check authorization
2. **Missing tool registration** - Update both `registry.ts` AND `tools/index.ts`
3. **Inconsistent naming** - Use `DOMAIN_ACTION` pattern (e.g., `API_KEY_CREATE`)
4. **Missing default permissions** - Add to `auth/index.ts` if users should have access by default
5. **Exposing sensitive data** - Only return secrets at creation time
6. **Missing organization check** - Use `requireOrganization(ctx)` for org-scoped resources
