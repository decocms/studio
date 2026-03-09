import type { Step } from "@decocms/bindings/workflow";
import { z, type ZodTypeAny } from "zod";
import { proxyConnectionForId } from "./bindings.ts";
import { MCPClient } from "./mcp.ts";

/**
 * Declarative workflow definition for MCP servers.
 * Workflows declared here are automatically synced to the mesh
 * as workflow_collection entries during ON_MCP_CONFIGURATION, and a
 * trigger tool is automatically generated for each one.
 */
export interface WorkflowDefinition {
  title: string;
  description?: string;
  /**
   * Virtual MCP ID that will execute this workflow's steps.
   * Used as the default for the generated trigger tool.
   * Can be overridden at call time via the tool's `virtual_mcp_id` input.
   */
  virtual_mcp_id?: string;
  steps: Step[];
  /**
   * Override the auto-generated tool ID for the workflow trigger tool.
   * Defaults to START_WORKFLOW_<TITLE_SLUG> (e.g. START_WORKFLOW_FETCH_USERS).
   */
  toolId?: string;
}

interface WorkflowCollectionItem {
  id: string;
  title: string;
  description: string | null;
  virtual_mcp_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DefaultVirtualMCPItem {
  id: string;
  title: string;
}

/**
 * Hand-rolled client interface for the workflow collection tools exposed by
 * the mesh's /mcp/self endpoint.
 *
 * TODO: Replace with a generated client derived from WorkflowBinding in
 * @decocms/bindings/workflow once that binding covers write operations
 * (CREATE, UPDATE, DELETE) and COLLECTION_WORKFLOW_EXECUTION_CREATE.
 * Until then, any rename of a tool or field on the server side requires a
 * matching change here — the bindings system was designed to prevent exactly
 * this class of silent drift.
 */
interface MeshWorkflowClient {
  COLLECTION_WORKFLOW_LIST: (input: {
    limit?: number;
    offset?: number;
  }) => Promise<{
    items: WorkflowCollectionItem[];
    totalCount: number;
    hasMore: boolean;
  }>;
  COLLECTION_WORKFLOW_CREATE: (input: {
    data: {
      id: string;
      title: string;
      description?: string;
      virtual_mcp_id?: string;
      steps: Step[];
    };
  }) => Promise<{ item: WorkflowCollectionItem }>;
  COLLECTION_WORKFLOW_UPDATE: (input: {
    id: string;
    data: {
      title?: string;
      description?: string;
      virtual_mcp_id?: string;
      steps?: Step[];
    };
  }) => Promise<{ success: boolean; error?: string }>;
  COLLECTION_WORKFLOW_DELETE: (input: {
    id: string;
  }) => Promise<{ success: boolean; error?: string }>;
  COLLECTION_WORKFLOW_EXECUTION_CREATE: (input: {
    workflow_collection_id: string;
    virtual_mcp_id?: string;
    input?: Record<string, unknown>;
    start_at_epoch_ms?: number;
  }) => Promise<{ item: { id: string } }>;
  COLLECTION_VIRTUAL_MCP_LIST: (input: {
    where?: {
      operator: "and";
      conditions: Array<{ field: string[]; operator: string; value: unknown }>;
    };
    limit?: number;
    offset?: number;
  }) => Promise<{
    items: DefaultVirtualMCPItem[];
    totalCount: number;
    hasMore: boolean;
  }>;
  COLLECTION_VIRTUAL_MCP_CREATE: (input: {
    data: {
      title: string;
      connections: Array<{
        connection_id: string;
        selected_tools: null;
      }>;
    };
  }) => Promise<{ item: DefaultVirtualMCPItem }>;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function workflowId(connectionId: string, title: string): string {
  return `${connectionId}::${slugify(title)}`;
}

/**
 * Derives the auto-generated trigger tool ID for a workflow.
 * "Fetch Users and Process" → "START_WORKFLOW_FETCH_USERS_AND_PROCESS"
 */
export function workflowToolId(title: string): string {
  return `START_WORKFLOW_${slugify(title).toUpperCase().replace(/-/g, "_")}`;
}

function createMeshSelfClient(
  meshUrl: string,
  token?: string,
): MeshWorkflowClient {
  const connection = proxyConnectionForId("self", { meshUrl, token });
  return MCPClient.forConnection(connection) as unknown as MeshWorkflowClient;
}

// I7: Per-connectionId mutex — chains incoming syncs so operations never interleave.
const syncInFlight = new Map<string, Promise<void>>();

// I4: Fingerprint of the last successfully synced declared set, keyed by connectionId.
// Capped at MAX_FINGERPRINT_CACHE entries to prevent unbounded growth in environments
// with rotating connection IDs. Oldest entry is evicted when the cap is reached.
// Callers that own connection lifecycle should call Workflow.clearFingerprint() on teardown.
const MAX_FINGERPRINT_CACHE = 500;
const workflowFingerprints = new Map<string, string>();

function setFingerprint(connectionId: string, fingerprint: string) {
  if (
    !workflowFingerprints.has(connectionId) &&
    workflowFingerprints.size >= MAX_FINGERPRINT_CACHE
  ) {
    const firstKey = workflowFingerprints.keys().next().value;
    if (firstKey !== undefined) workflowFingerprints.delete(firstKey);
  }
  workflowFingerprints.set(connectionId, fingerprint);
}

// Derives the title for the auto-generated default Virtual MCP.
// Embedding the connectionId makes each VMCP identifiable in the UI and
// uniquely addressable in LIST lookups without relying on the connection_id
// filter alone (which would match any VMCP that includes this connection).
function defaultVmcpTitle(connectionId: string): string {
  return `Workflows Agent (${connectionId})`;
}

// Cache of connectionId → auto-created default Virtual MCP ID.
// Capped at the same size as the fingerprint cache.
const defaultVmcpByConnection = new Map<string, string>();

function setDefaultVmcp(connectionId: string, vmcpId: string) {
  if (
    !defaultVmcpByConnection.has(connectionId) &&
    defaultVmcpByConnection.size >= MAX_FINGERPRINT_CACHE
  ) {
    const firstKey = defaultVmcpByConnection.keys().next().value;
    if (firstKey !== undefined) defaultVmcpByConnection.delete(firstKey);
  }
  defaultVmcpByConnection.set(connectionId, vmcpId);
}

/**
 * Returns the ID of the "Workflows Agent" Virtual MCP for a connection,
 * creating one if it does not yet exist.
 *
 * Resolution order:
 *   1. Module-level cache (avoids the round-trip within a process lifetime).
 *   2. Remote LIST filtered by connection_id + title (survives restarts).
 *   3. Remote CREATE — only when no matching VMCP is found.
 *
 * Any network failure is logged and causes the function to return undefined
 * so callers continue without a default rather than failing the whole sync.
 */
async function resolveDefaultVirtualMcp(
  connectionId: string,
  client: MeshWorkflowClient,
  tag: string,
): Promise<string | undefined> {
  const cached = defaultVmcpByConnection.get(connectionId);
  if (cached) {
    console.log(`${tag} Using cached default Virtual MCP: ${cached}`);
    return cached;
  }

  const title = defaultVmcpTitle(connectionId);

  try {
    const result = await client.COLLECTION_VIRTUAL_MCP_LIST({
      where: {
        operator: "and",
        conditions: [
          { field: ["connection_id"], operator: "eq", value: connectionId },
          { field: ["title"], operator: "eq", value: title },
        ],
      },
      limit: 1,
    });
    if (result.items.length > 0) {
      const vmcpId = result.items[0]!.id;
      setDefaultVmcp(connectionId, vmcpId);
      console.log(`${tag} Found existing default Virtual MCP: ${vmcpId}`);
      return vmcpId;
    }
  } catch (err) {
    console.warn(
      `${tag} Could not list Virtual MCPs — proceeding without default. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  try {
    const created = await client.COLLECTION_VIRTUAL_MCP_CREATE({
      data: {
        title,
        connections: [{ connection_id: connectionId, selected_tools: null }],
      },
    });
    const vmcpId = created.item.id;
    setDefaultVmcp(connectionId, vmcpId);
    console.log(`${tag} Created default Virtual MCP: ${vmcpId}`);
    return vmcpId;
  } catch (err) {
    console.warn(
      `${tag} Could not create default Virtual MCP — proceeding without default. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function fingerprintWorkflows(declared: WorkflowDefinition[]): string {
  return JSON.stringify(
    declared.map((w) => ({
      title: w.title,
      description: w.description ?? null,
      virtual_mcp_id: w.virtual_mcp_id ?? null,
      steps: w.steps,
      toolId: w.toolId ?? null,
    })),
  );
}

async function doSyncWorkflows(
  declared: WorkflowDefinition[],
  meshUrl: string,
  connectionId: string,
  token?: string,
  _clientOverride?: MeshWorkflowClient,
): Promise<void> {
  const tag = `[Workflows][${connectionId}]`;

  // I6: Reject any title that slugifies to empty — would produce IDs like "conn_abc::".
  const emptySlugWf = declared.find((w) => slugify(w.title) === "");
  if (emptySlugWf !== undefined) {
    console.warn(
      `${tag} Workflow title "${emptySlugWf.title}" produces an empty ID. Skipping sync.`,
    );
    return;
  }

  if (declared.length > 0) {
    const slugs = declared.map((w) => slugify(w.title));
    const uniqueSlugs = new Set(slugs);
    if (uniqueSlugs.size !== slugs.length) {
      const duplicateSlugs = new Set(
        slugs.filter((s, i) => slugs.indexOf(s) !== i),
      );
      const collidingTitles = declared
        .filter((w) => duplicateSlugs.has(slugify(w.title)))
        .map((w) => w.title);
      console.warn(
        `${tag} Workflow titles that produce duplicate IDs: ${[...new Set(collidingTitles)].join(", ")}. Skipping sync.`,
      );
      return;
    }
  }

  // I4: Skip the remote round-trip when the declared set is identical to the last sync.
  const fingerprint = fingerprintWorkflows(declared);
  const storedFingerprint = workflowFingerprints.get(connectionId);
  if (storedFingerprint === fingerprint) {
    console.log(
      `${tag} Fingerprint unchanged — skipping sync. Declared: ${declared.length} workflow(s): [${declared.map((w) => w.title).join(", ")}]`,
    );
    return;
  }
  console.log(
    `${tag} Fingerprint changed (or first sync) — starting sync. Declared: ${declared.length} workflow(s): [${declared.map((w) => w.title).join(", ")}]`,
    storedFingerprint
      ? "(previous fingerprint existed)"
      : "(no previous fingerprint)",
  );

  const client = _clientOverride ?? createMeshSelfClient(meshUrl, token);

  // Resolve (or lazily create) the default Virtual MCP for this connection so
  // that workflows without an explicit virtual_mcp_id get a sensible default.
  const defaultVmcpId = await resolveDefaultVirtualMcp(
    connectionId,
    client,
    tag,
  );

  let existing: WorkflowCollectionItem[];
  try {
    const allItems: WorkflowCollectionItem[] = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const page = await client.COLLECTION_WORKFLOW_LIST({ limit, offset });
      allItems.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      offset += page.items.length;
    }
    existing = allItems;
    console.log(
      `${tag} LIST returned ${existing.length} total workflow(s). IDs owned by this connection: [${
        existing
          .filter((w) => w.id.startsWith(`${connectionId}::`))
          .map((w) => w.id)
          .join(", ") || "none"
      }]`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `${tag} Could not list workflows (workflows plugin may not be enabled). Skipping sync. Error: ${errMsg}`,
    );
    return;
  }

  const prefix = `${connectionId}::`;
  const managed = new Map(
    existing.filter((w) => w.id.startsWith(prefix)).map((w) => [w.id, w]),
  );

  // I5: Build ID→definition map synchronously so declaredIds is ready before
  // parallelizing — the orphan-delete pass needs the complete set upfront.
  const declaredEntries = declared.map(
    (wf) => [workflowId(connectionId, wf.title), wf] as const,
  );
  const declaredIds = new Set(declaredEntries.map(([id]) => id));

  let hadError = false;

  // I5: Upserts run in parallel — no ordering dependency between workflows.
  await Promise.all(
    declaredEntries.map(async ([id, wf]) => {
      const op = managed.has(id) ? "UPDATE" : "CREATE";
      console.log(`${tag} ${op} "${wf.title}" (id=${id})`);
      try {
        // Explicit declaration wins; fall back to the auto-resolved default.
        const resolvedVmcpId = wf.virtual_mcp_id ?? defaultVmcpId;

        if (op === "UPDATE") {
          const result = await client.COLLECTION_WORKFLOW_UPDATE({
            id,
            data: {
              title: wf.title,
              description: wf.description,
              ...(resolvedVmcpId !== undefined && {
                virtual_mcp_id: resolvedVmcpId,
              }),
              steps: wf.steps,
            },
          });
          if (!result.success) {
            hadError = true;
            console.warn(
              `${tag} UPDATE "${wf.title}" returned success=false:`,
              String(result.error ?? "(no error message)"),
            );
          } else {
            console.log(`${tag} UPDATE "${wf.title}" OK`);
          }
        } else {
          await client.COLLECTION_WORKFLOW_CREATE({
            data: {
              id,
              title: wf.title,
              description: wf.description,
              virtual_mcp_id: resolvedVmcpId,
              steps: wf.steps,
            },
          });
          console.log(`${tag} CREATE "${wf.title}" OK`);
        }
      } catch (error) {
        hadError = true;
        console.warn(
          `${tag} Failed to ${op} workflow "${wf.title}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );

  // I5: Deletes run in parallel — orphans are independent of each other.
  const orphanIds = [...managed.keys()].filter((id) => !declaredIds.has(id));
  if (orphanIds.length > 0) {
    console.log(
      `${tag} Deleting ${orphanIds.length} orphaned workflow(s): [${orphanIds.join(", ")}]`,
    );
  }
  await Promise.all(
    orphanIds.map(async (id) => {
      try {
        await client.COLLECTION_WORKFLOW_DELETE({ id });
        console.log(`${tag} DELETE "${id}" OK`);
      } catch (error) {
        hadError = true;
        console.warn(
          `${tag} Failed to delete orphaned workflow "${id}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );

  // I4: Only record the fingerprint when every operation succeeded so that
  // a follow-up call with an identical declared set retries any failures
  // rather than silently skipping them.
  if (!hadError) {
    setFingerprint(connectionId, fingerprint);
    console.log(`${tag} Sync complete — fingerprint stored.`);
  } else {
    console.warn(
      `${tag} Sync finished with errors — fingerprint NOT stored so the next call will retry.`,
    );
  }
}

async function syncWorkflows(
  declared: WorkflowDefinition[],
  meshUrl: string,
  connectionId: string,
  token?: string,
  /**
   * @internal Only used in tests to capture payloads without a real server.
   * Not part of the public API contract; may be removed without notice.
   */
  _clientOverride?: MeshWorkflowClient,
): Promise<void> {
  // I7: Chain onto any in-flight sync for this connectionId so concurrent calls
  // never interleave LIST/CREATE/DELETE operations against the same connection.
  const previous = syncInFlight.get(connectionId) ?? Promise.resolve();
  const next = previous
    // Isolate from predecessor's rejection so a failed prior sync doesn't
    // propagate its error to unrelated callers queued behind it.
    .catch(() => {})
    .then(() =>
      doSyncWorkflows(declared, meshUrl, connectionId, token, _clientOverride),
    )
    .finally(() => {
      if (syncInFlight.get(connectionId) === next) {
        syncInFlight.delete(connectionId);
      }
    });
  syncInFlight.set(connectionId, next);
  return next;
}

/**
 * Scopes required by a connection that declares workflows.
 * Co-located here so any rename of a server-side tool name causes a compile
 * error in the consumer rather than a silent scope mismatch.
 */
export const WORKFLOW_SCOPES = [
  "SELF::COLLECTION_WORKFLOW_LIST",
  "SELF::COLLECTION_WORKFLOW_CREATE",
  "SELF::COLLECTION_WORKFLOW_UPDATE",
  "SELF::COLLECTION_WORKFLOW_DELETE",
  "SELF::COLLECTION_WORKFLOW_EXECUTION_CREATE",
  "SELF::COLLECTION_VIRTUAL_MCP_LIST",
  "SELF::COLLECTION_VIRTUAL_MCP_CREATE",
] as const;

export const Workflow = {
  sync: syncWorkflows,
  slugify,
  workflowId,
  toolId: workflowToolId,
  /**
   * Creates a workflow execution via the mesh self-endpoint.
   * Returns the execution ID of the newly created execution.
   * This keeps the MeshWorkflowClient factory internal to this module.
   */
  createExecution: async (
    meshUrl: string,
    token: string | undefined,
    params: {
      workflow_collection_id: string;
      virtual_mcp_id?: string;
      input?: Record<string, unknown>;
      start_at_epoch_ms?: number;
    },
  ): Promise<string> => {
    const client = createMeshSelfClient(meshUrl, token);
    const result = await client.COLLECTION_WORKFLOW_EXECUTION_CREATE(params);
    return result.item.id;
  },
  /**
   * Clears the cached fingerprint and default Virtual MCP ID for a connection
   * so the next sync performs a full remote round-trip. Call this on connection
   * teardown or when you need to force a re-sync without changing the declared
   * workflow set.
   */
  clearFingerprint: (connectionId: string) => {
    workflowFingerprints.delete(connectionId);
    defaultVmcpByConnection.delete(connectionId);
  },
};

// ============================================================================
// Fluent Workflow Builder
// ============================================================================

/**
 * Minimal tool shape for builder type inference and schema injection.
 * Defined locally to avoid a circular import with tools.ts (which imports
 * WorkflowDefinition from this file). Includes inputSchema so the builder
 * can derive per-tool input key suggestions, and outputSchema so the builder
 * can auto-inject a step's outputSchema to detect schema drift at sync time.
 */
type ToolLike<TId extends string = string> = {
  id: TId;
  inputSchema: ZodTypeAny;
  outputSchema?: ZodTypeAny;
};

/**
 * All valid @ref strings given the set of declared step names TSteps.
 *
 * - `@input` / `@input.field`       — workflow input
 * - `@stepName` / `@stepName.field` — output of a declared step
 * - `@item` / `@item.${string}`     — current forEach item
 * - `@index`                        — current forEach index
 * - `@ctx.execution_id`             — current execution ID
 *
 * `string & {}` keeps the type as `string` so arbitrary values still compile,
 * but the union members get autocomplete and type-narrowing in editors.
 */
type KnownRefs<TSteps extends string> =
  | `@input`
  | `@input.${string}`
  | `@item`
  | `@item.${string}`
  | `@index`
  | `@ctx.execution_id`
  | `@${TSteps}`
  | `@${TSteps}.${string}`
  | (string & {});

type StepInput<TSteps extends string> = Record<
  string,
  KnownRefs<TSteps> | unknown
>;

/**
 * Derives the `input` type for a tool step.
 *
 * Keys are the tool's inputSchema field names (for autocomplete); values are
 * @refs or any literal. An index signature allows additional arbitrary keys.
 * Falls back to generic StepInput when the tool is not found in TTools.
 */
type InputForTool<
  TTools extends readonly ToolLike[],
  TId extends string,
  TSteps extends string,
> = Extract<TTools[number], { id: TId }> extends { inputSchema: infer TIn }
  ? TIn extends ZodTypeAny
    ? {
        [K in keyof TIn["_output"]]?: KnownRefs<TSteps> | TIn["_output"][K];
      } & { [key: string]: KnownRefs<TSteps> | unknown }
    : StepInput<TSteps>
  : StepInput<TSteps>;

type BaseStepFields = Omit<Step, "name" | "input" | "action">;
type BaseForEachFields = Omit<Step, "name" | "forEach" | "input" | "action">;

/**
 * Tool-call variants of StepOpts — one discriminated member per tool ID so
 * TypeScript narrows the `input` type based on the value of `toolName`.
 * Falls back to `string` for toolName when no tools are registered.
 */
type ToolCallStepOpts<
  TSteps extends string,
  TTools extends readonly ToolLike[],
> = [TTools[number]] extends [never]
  ? BaseStepFields & {
      action: { toolName: string & {}; transformCode?: string };
      input?: StepInput<TSteps>;
    }
  : {
      [TId in TTools[number]["id"]]: BaseStepFields & {
        action: { toolName: TId; transformCode?: string };
        input?: InputForTool<TTools, TId, TSteps>;
      };
    }[TTools[number]["id"]];

type StepOpts<TSteps extends string, TTools extends readonly ToolLike[]> =
  | ToolCallStepOpts<TSteps, TTools>
  | (BaseStepFields & { action: { code: string }; input?: StepInput<TSteps> });

type ToolCallForEachOpts<
  TSteps extends string,
  TTools extends readonly ToolLike[],
> = [TTools[number]] extends [never]
  ? BaseForEachFields & {
      action: { toolName: string & {}; transformCode?: string };
      input?: StepInput<TSteps>;
      concurrency?: number;
    }
  : {
      [TId in TTools[number]["id"]]: BaseForEachFields & {
        action: { toolName: TId; transformCode?: string };
        input?: InputForTool<TTools, TId, TSteps>;
        concurrency?: number;
      };
    }[TTools[number]["id"]];

type ForEachItemOpts<
  TSteps extends string,
  TTools extends readonly ToolLike[],
> =
  | ToolCallForEachOpts<TSteps, TTools>
  | (BaseForEachFields & {
      action: { code: string };
      input?: StepInput<TSteps>;
      concurrency?: number;
    });

class WorkflowBuilder<
  TSteps extends string = never,
  TTools extends readonly ToolLike[] = never[],
> {
  private readonly _steps: Step[] = [];
  private readonly _tools: readonly ToolLike[];

  constructor(
    private readonly meta: Omit<WorkflowDefinition, "steps">,
    tools: readonly ToolLike[] = [],
  ) {
    this._tools = tools;
  }

  /**
   * Auto-injects the referenced tool's outputSchema into the step if:
   * 1. The step action is a tool call (has toolName)
   * 2. The matched tool has an outputSchema
   * 3. The step does not already have an explicit outputSchema
   *
   * This ensures that when a tool's outputSchema changes, the workflow
   * fingerprint changes and the sync correctly updates the stored workflow.
   */
  private _withToolSchema(step: Step): Step {
    const action = step.action as { toolName?: string } | undefined;
    if (!action?.toolName) return step;
    const tool = this._tools.find((t) => t.id === action.toolName);
    if (!tool?.outputSchema || step.outputSchema !== undefined) return step;
    return {
      ...step,
      outputSchema: z.toJSONSchema(tool.outputSchema) as Step["outputSchema"],
    };
  }

  step<TName extends string>(
    name: TName,
    opts: StepOpts<TSteps, TTools>,
  ): WorkflowBuilder<TSteps | TName, TTools> {
    this._steps.push(
      this._withToolSchema({ name, ...(opts as Omit<Step, "name">) }),
    );
    return this as unknown as WorkflowBuilder<TSteps | TName, TTools>;
  }

  /**
   * Creates a step that iterates over an array resolved from a @ref.
   * Maps to the engine's Step.forEach field.
   *
   * @param name  - Unique step name
   * @param ref   - @ref to the array to iterate (e.g. "@fetch_users")
   * @param opts  - Step definition (action, input, config, outputSchema)
   */
  forEachItem<TName extends string>(
    name: TName,
    ref: KnownRefs<TSteps>,
    opts: ForEachItemOpts<TSteps, TTools>,
  ): WorkflowBuilder<TSteps | TName, TTools> {
    const { concurrency = 1, ...rest } = opts;
    this._steps.push(
      this._withToolSchema({
        name,
        ...(rest as Omit<Step, "name" | "forEach">),
        forEach: { ref, concurrency },
      }),
    );
    return this as unknown as WorkflowBuilder<TSteps | TName, TTools>;
  }

  /**
   * Spreads an array of pre-built steps into the workflow.
   * Step names from the array are not tracked in the type — use .step() for
   * tracked composition.
   */
  addSteps(steps: Step[]): this {
    this._steps.push(...steps);
    return this;
  }

  build(): WorkflowDefinition {
    return { ...this.meta, steps: [...this._steps] };
  }
}

/**
 * Fluent builder for workflow definitions.
 *
 * Pass your locally-declared tools as the second argument to get autocomplete
 * for `toolName` throughout the workflow. Step names are also tracked so
 * `@ref` strings autocomplete in `input` after each `.step()` call.
 *
 * @example
 * const GET_USERS = createTool({ id: "GET_USERS", ... });
 * const PROCESS_USER = createTool({ id: "PROCESS_USER", ... });
 *
 * const myWorkflow = createWorkflow(
 *   { title: "Fetch and Process" },
 *   [GET_USERS, PROCESS_USER],
 * )
 *   .step("fetch_users", {
 *     action: { toolName: "GET_USERS" },  // ← autocomplete: "GET_USERS" | "PROCESS_USER"
 *   })
 *   .forEachItem("process_user", "@fetch_users", {
 *     //                          ^ autocomplete: @fetch_users, @input, @item...
 *     action: { toolName: "PROCESS_USER" },
 *     input: { userId: "@item.id" },
 *   })
 *   .build();
 */
export function createWorkflow<TTools extends readonly ToolLike[] = never[]>(
  meta: Omit<WorkflowDefinition, "steps">,
  tools?: TTools,
): WorkflowBuilder<never, TTools> {
  return new WorkflowBuilder(meta, tools ?? []) as unknown as WorkflowBuilder<
    never,
    TTools
  >;
}
