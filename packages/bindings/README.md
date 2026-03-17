# @decocms/bindings

Core type definitions and utilities for the bindings system. Bindings define standardized interfaces that integrations (MCPs - Model Context Protocols) can implement, similar to TypeScript interfaces but with runtime validation.

## Installation

Install the package using npm or bun:

```bash
npm install @decocms/bindings
```

or with bun:

```bash
bun add @decocms/bindings
```

**Note:** This package requires `zod` as a peer dependency. If you don't already have `zod` installed in your project, you'll need to install it separately.

## What are Bindings?

Bindings are a core concept for defining and enforcing standardized interfaces that MCPs can implement. They provide a type-safe, declarative way to specify what tools (methods) and schemas an integration must expose to be compatible with certain parts of the system.

### Key Features

- **Standardization**: Define contracts (schemas and method names) that MCPs must implement
- **Type Safety**: Leverage Zod schemas and TypeScript types for correct data structures
- **Runtime Validation**: Check if an integration implements a binding at runtime
- **Extensibility**: Create new bindings for any use case

## Usage

### 1. Defining a Binding

A binding is an array of tool definitions, each specifying a name and input/output schemas:

```typescript
import { z } from "zod";
import type { Binder } from "@decocms/bindings";

// Define input/output schemas
const joinChannelInput = z.object({
  workspace: z.string(),
  discriminator: z.string(),
  agentId: z.string(),
});

const channelOutput = z.object({
  success: z.boolean(),
  channelId: z.string(),
});

// Define the binding
export const CHANNEL_BINDING = [
  {
    name: "DECO_CHAT_CHANNELS_JOIN" as const,
    inputSchema: joinChannelInput,
    outputSchema: channelOutput,
  },
  {
    name: "DECO_CHAT_CHANNELS_LEAVE" as const,
    inputSchema: z.object({ channelId: z.string() }),
    outputSchema: z.object({ success: z.boolean() }),
  },
  {
    name: "DECO_CHAT_CHANNELS_LIST" as const,
    inputSchema: z.object({}),
    outputSchema: z.object({
      channels: z.array(z.object({
        label: z.string(),
        value: z.string(),
      })),
    }),
    opt: true, // This tool is optional
  },
] as const satisfies Binder;
```

### 2. Checking if Tools Implement a Binding

Use `createBindingChecker` to verify if a set of tools implements a binding:

```typescript
import { createBindingChecker } from "@decocms/bindings";

// Create a checker for your binding
const channelChecker = createBindingChecker(CHANNEL_BINDING);

// Check if available tools implement the binding
const availableTools = [
  { name: "DECO_CHAT_CHANNELS_JOIN" },
  { name: "DECO_CHAT_CHANNELS_LEAVE" },
  { name: "DECO_CHAT_CHANNELS_LIST" },
  { name: "OTHER_TOOL" },
];

const isImplemented = channelChecker.isImplementedBy(availableTools);
console.log(isImplemented); // true - all required tools are present

// Optional tools don't need to be present
const minimalTools = [
  { name: "DECO_CHAT_CHANNELS_JOIN" },
  { name: "DECO_CHAT_CHANNELS_LEAVE" },
];

const stillValid = channelChecker.isImplementedBy(minimalTools);
console.log(stillValid); // true - CHANNELS_LIST is optional
```

### 3. Using RegExp for Tool Names

You can use RegExp patterns for flexible tool matching:

```typescript
export const RESOURCE_BINDING = [
  {
    name: /^DECO_RESOURCE_\w+_SEARCH$/ as RegExp,
    inputSchema: z.object({ term: z.string() }),
    outputSchema: z.object({ items: z.array(z.any()) }),
  },
] as const satisfies Binder;

// This will match: DECO_RESOURCE_WORKFLOW_SEARCH, DECO_RESOURCE_USER_SEARCH, etc.
```

### 4. Type Safety with Bindings

TypeScript can infer types from your binding definitions:

```typescript
import type { ToolBinder } from "@decocms/bindings";

// Extract the type of a specific tool
type JoinChannelTool = typeof CHANNEL_BINDING[0];

// Get input type
type JoinChannelInput = z.infer<JoinChannelTool["inputSchema"]>;

// Get output type
type JoinChannelOutput = z.infer<NonNullable<JoinChannelTool["outputSchema"]>>;
```

## API Reference

### Types

#### `ToolBinder<TName, TInput, TReturn>`

Defines a single tool within a binding.

- `name`: Tool name (string or RegExp)
- `inputSchema`: Zod schema for input validation
- `outputSchema?`: Optional Zod schema for output validation
- `opt?`: If true, tool is optional in the binding

#### `Binder<TDefinition>`

Represents a collection of tool definitions that form a binding.

#### `BindingChecker`

Interface with an `isImplementedBy` method for checking binding implementations.

### Functions

#### `createBindingChecker<TDefinition>(binderTools: TDefinition): BindingChecker`

Creates a binding checker that can verify if a set of tools implements the binding.

**Parameters:**
- `binderTools`: The binding definition to check against

**Returns:**
- A `BindingChecker` with an `isImplementedBy` method

**Example:**
```typescript
const checker = createBindingChecker(MY_BINDING);
const isValid = checker.isImplementedBy(availableTools);
```

## Common Patterns

### Well-Known Bindings

The package includes pre-defined bindings for common use cases. Well-known bindings are organized in the `well-known` folder and must be imported directly:

- **Collections**: `@decocms/bindings/collections` - Collection bindings for SQL table-like structures
- **Models**: `@decocms/bindings/models` - AI model providers interface

See the [Collection Bindings](#collection-bindings) and [Models Bindings](#models-bindings) sections below for detailed usage examples.

### Generic Bindings

Create factory functions for generic bindings:

```typescript
function createResourceBinding(resourceName: string) {
  return [
    {
      name: `DECO_RESOURCE_${resourceName.toUpperCase()}_SEARCH` as const,
      inputSchema: z.object({ term: z.string() }),
      outputSchema: z.object({ items: z.array(z.any()) }),
    },
    {
      name: `DECO_RESOURCE_${resourceName.toUpperCase()}_READ` as const,
      inputSchema: z.object({ uri: z.string() }),
      outputSchema: z.object({ data: z.any() }),
    },
  ] as const satisfies Binder;
}

const workflowBinding = createResourceBinding("workflow");
```

## Collection Bindings

Collection bindings provide standardized CRUD + Search operations for SQL table-like collections, compatible with TanStack DB query-collection. They are designed for database tables where each entity has a unique ID and human-readable title.

### Key Features

- **SQL Table-like Structure**: Represents database tables with standardized operations
- **Simple Identification**: Uses human-readable `id` and `title` fields
- **Audit Trail**: All entities must include `created_at`, `updated_at`, `created_by`, and `updated_by` fields
- **TanStack DB Compatible**: Works seamlessly with TanStack DB's query-collection LoadSubsetOptions
- **Type-Safe**: Full TypeScript support with Zod validation

### Base Entity Schema Requirements

All collection entity schemas must extend `BaseCollectionEntitySchema`, which requires:

- `id`: Unique identifier for the entity (string)
- `title`: Human-readable title for the entity (string)
- `created_at`: Creation timestamp (datetime string)
- `updated_at`: Last update timestamp (datetime string)
- `created_by`: User who created the entity (optional string)
- `updated_by`: User who last updated the entity (optional string)

### Using Collection Bindings

Collection bindings are a well-known binding pattern for SQL table-like structures. Import them from the well-known collections module:

```typescript
import { z } from "zod";
import { createCollectionBindings } from "@decocms/bindings/collections";
import { createBindingChecker } from "@decocms/bindings";

// Define your entity schema extending the base schema
const TodoSchema = z.object({
  id: z.string(), // Unique identifier
  title: z.string(), // Human-readable title (from base schema)
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string().optional(),
  updated_by: z.string().optional(),
  // Your custom fields
  completed: z.boolean(),
  userId: z.number(),
});

// Create the collection binding (full CRUD)
const TODO_COLLECTION_BINDING = createCollectionBindings("todos", TodoSchema);

// Create a read-only collection binding (only LIST and GET)
const READONLY_COLLECTION_BINDING = createCollectionBindings("products", ProductSchema, {
  readOnly: true,
});

// Create a checker to verify if tools implement the binding
const todoChecker = createBindingChecker(TODO_COLLECTION_BINDING);

// Check if available tools implement the binding
const availableTools = [
  { name: "TODOS_LIST" },
  { name: "TODOS_GET" },
  { name: "TODOS_CREATE" },
  { name: "TODOS_UPDATE" },
  { name: "TODOS_DELETE" },
];

const isImplemented = todoChecker.isImplementedBy(availableTools);
console.log(isImplemented); // true if all required tools are present
```

### Collection Operations

The `createCollectionBindings` function generates tool bindings based on the `readOnly` option:

**Required operations (always included):**

1. **LIST** - `{NAME}_LIST`
   - Query/search entities with filtering, sorting, and pagination
   - Input: `where?`, `orderBy?`, `limit?`, `offset?`
   - Output: `items[]`, `totalCount?`, `hasMore?`

2. **GET** - `{NAME}_GET`
   - Get a single entity by ID
   - Input: `id` (string)
   - Output: `item | null`

**Optional operations (excluded if `readOnly: true`):**

3. **CREATE** - `{NAME}_CREATE`
   - Create a new entity
   - Input: `data` (id may be auto-generated by the server)
   - Output: `item` (with generated id)

4. **UPDATE** - `{NAME}_UPDATE`
   - Update an existing entity
   - Input: `id` (string), `data` (partial)
   - Output: `item`

5. **DELETE** - `{NAME}_DELETE`
   - Delete an entity
   - Input: `id` (string)
   - Output: `success` (boolean), `id` (string)

### Read-Only Collections

To create a read-only collection (only LIST and GET operations), pass `{ readOnly: true }` as the third parameter:

```typescript
// Read-only collection - only LIST and GET operations
const READONLY_COLLECTION_BINDING = createCollectionBindings(
  "products",
  ProductSchema,
  { readOnly: true }
);
```

This is useful for collections that are managed externally or should not be modified through the MCP interface.

## Models Bindings

Models bindings provide a well-known interface for AI model providers. They use collection bindings under the hood for LIST and GET operations, with streaming endpoint information included directly in each model entity.

### Using Models Bindings

```typescript
import { MODELS_BINDING, MODELS_COLLECTION_BINDING } from "@decocms/bindings/models";
import { createBindingChecker } from "@decocms/bindings";

// Use the pre-defined MODELS_BINDING
const modelsChecker = createBindingChecker(MODELS_BINDING);

// Check if available tools implement the binding
const availableTools = [
  { name: "MODELS_LIST" },
  { name: "MODELS_GET" },
];

const isImplemented = modelsChecker.isImplementedBy(availableTools);
console.log(isImplemented); // true if all required tools are present
```

### Models Binding Tools

The `MODELS_BINDING` includes:

1. **MODELS_LIST** (required)
   - List available AI models with their capabilities and streaming endpoints
   - Uses collection binding LIST operation
   - Input: `where?`, `orderBy?`, `limit?`, `offset?`
   - Output: `items[]` (array of model entities with endpoint info)

2. **MODELS_GET** (required)
   - Get a single model by ID
   - Uses collection binding GET operation
   - Input: `id` (string)
   - Output: `item | null` (model entity with endpoint info)

### Model Entity Schema

Models follow the collection entity schema with additional model-specific fields:

```typescript
{
  id: string;                      // Unique identifier (from base schema)
  title: string;                   // Display name (from base schema)
  created_at: string;              // Creation timestamp
  updated_at: string;              // Last update timestamp
  created_by?: string;             // User who created
  updated_by?: string;             // User who last updated
  logo: string | null;             // Logo URL
  description: string | null;      // Model description
  capabilities: string[];          // Array of capabilities
  limits: {                        // Model limits
    contextWindow: number;         // Maximum context window size
    maxOutputTokens: number;       // Maximum output tokens
  } | null;
  costs: {                         // Model costs
    input: number;                 // Cost per input token
    output: number;                // Cost per output token
  } | null;
  endpoint: {                      // Streaming endpoint information
    url: string;                   // Endpoint URL
    method: string;                // HTTP method (default: "POST")
    contentType: string;           // Content type (default: "application/json")
    stream: boolean;               // Supports streaming (default: true)
  } | null;
}
```

### MCP Implementation Example

Here's how you would implement the models binding in an MCP server:

```typescript
import { MODELS_BINDING } from "@decocms/bindings/models";
import { impl } from "@decocms/sdk/mcp/bindings/binder";

const modelTools = impl(MODELS_BINDING, [
  {
    description: "List available AI models",
    handler: async ({ where, orderBy, limit, offset }) => {
      // Query your models database
      const items = await db.models.findMany({
        where: convertWhereToSQL(where),
        orderBy: convertOrderByToSQL(orderBy),
        take: limit,
        skip: offset,
      });
      
      // Include endpoint info in each model
      return { items, hasMore: items.length === limit };
    },
  },
  {
    description: "Get a model by ID",
    handler: async ({ id }) => {
      const item = await db.models.findUnique({
        where: { id },
      });
      return { item };
    },
  },
]);
```

### Where Expression Structure

The `where` parameter supports TanStack DB predicate push-down patterns:

```typescript
// Simple comparison
{
  field: ["category"],
  operator: "eq",
  value: "electronics"
}

// Logical operators
{
  operator: "and",
  conditions: [
    { field: ["category"], operator: "eq", value: "electronics" },
    { field: ["price"], operator: "lt", value: 100 }
  ]
}
```

**Supported Operators:**
- Comparison: `eq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `contains`
- Logical: `and`, `or`, `not`

### Order By Expression Structure

The `orderBy` parameter supports multi-field sorting:

```typescript
[
  {
    field: ["price"],
    direction: "asc",
    nulls: "last" // optional: "first" | "last"
  },
  {
    field: ["created_at"],
    direction: "desc"
  }
]
```

### TanStack DB Integration

Collection bindings are designed to work with TanStack DB's query-collection. The `where` and `orderBy` expressions are compatible with TanStack DB's `LoadSubsetOptions`, allowing for efficient predicate push-down to your backend.

### MCP Implementation Example

Here's how you would implement a collection binding in an MCP server:

```typescript
import { z } from "zod";
import { createCollectionBindings } from "@decocms/bindings/collections";
import { impl } from "@decocms/sdk/mcp/bindings/binder";

const TodoSchema = z.object({
  id: z.string(),
  title: z.string(), // From base schema
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string().optional(),
  updated_by: z.string().optional(),
  completed: z.boolean(),
  userId: z.number(),
});

const TODO_COLLECTION_BINDING = createCollectionBindings("todos", TodoSchema);

// Implement the tools
const todoTools = impl(TODO_COLLECTION_BINDING, [
  {
    description: "List todos with filtering and sorting",
    handler: async ({ where, orderBy, limit, offset }) => {
      // Convert where/orderBy to SQL and query database
      const items = await db.todos.findMany({
        where: convertWhereToSQL(where),
        orderBy: convertOrderByToSQL(orderBy),
        take: limit,
        skip: offset,
      });
      
      return { items, hasMore: items.length === limit };
    },
  },
  {
    description: "Get a todo by ID",
    handler: async ({ id }) => {
      const item = await db.todos.findUnique({
        where: { id },
      });
      return { item };
    },
  },
  {
    description: "Create a new todo",
    handler: async ({ data }) => {
      const item = await db.todos.create({ 
        data: {
          ...data,
          id: data.id || generateId(), // Use provided ID or generate one
        }
      });
      return { item };
    },
  },
  {
    description: "Update a todo",
    handler: async ({ id, data }) => {
      const item = await db.todos.update({
        where: { id },
        data,
      });
      return { item };
    },
  },
  {
    description: "Delete a todo",
    handler: async ({ id }) => {
      await db.todos.delete({ where: { id } });
      return { success: true, id };
    },
  },
]);
```

### Type Safety

TypeScript can infer types from your collection binding definitions:

```typescript
import type {
  CollectionBinding,
  CollectionTools,
  CollectionListInput,
  CollectionGetInput,
  CollectionDeleteInput,
} from "@decocms/bindings/collections";

// Extract the binding type
type TodoBinding = typeof TODO_COLLECTION_BINDING;

// Extract tool names
type TodoTools = CollectionTools<typeof TodoSchema>;
// "TODOS_LIST" | "TODOS_GET" | ...

// Get input types
type ListInput = CollectionListInput;
type GetInput = CollectionGetInput;
type DeleteInput = CollectionDeleteInput;
```

## Development

### Setup

```bash
# Install dependencies
bun install

# Build the package
bun run build

# Run tests
bun run test

# Watch mode for tests
bun run test:watch
```

### Building

The package uses [tsup](https://tsup.egoist.dev/) for building:

```bash
bun run build
```

This will generate ESM output in the `dist/` directory with TypeScript declarations.

### Testing

Tests are written with [Bun](https://bun.com/docs/test):

```bash
# Run tests once
bun test

# Watch mode
bun test --watch
```

## Publishing

The package is automatically published to npm when a tag matching `bindings-v*` is pushed:

```bash
# Update version in package.json, then:
git tag bindings-v0.1.0
git push origin bindings-v0.1.0
```

## License

See the root LICENSE.md file in the repository.

