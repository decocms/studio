import type { Step } from "@decocms/bindings/workflow";
import type { ZodTypeAny } from "zod";
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
const workflowFingerprints = new Map<string, string>();

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
  // I6: Reject any title that slugifies to empty — would produce IDs like "conn_abc::".
  const emptySlugWf = declared.find((w) => slugify(w.title) === "");
  if (emptySlugWf !== undefined) {
    console.warn(
      `[Workflows] Workflow title "${emptySlugWf.title}" produces an empty ID. Skipping sync.`,
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
        `[Workflows] Workflow titles that produce duplicate IDs: ${[...new Set(collidingTitles)].join(", ")}. Skipping sync.`,
      );
      return;
    }
  }

  // I4: Skip the remote round-trip when the declared set is identical to the last sync.
  const fingerprint = fingerprintWorkflows(declared);
  if (workflowFingerprints.get(connectionId) === fingerprint) return;

  const client = _clientOverride ?? createMeshSelfClient(meshUrl, token);

  let existing: WorkflowCollectionItem[];
  try {
    const allItems: WorkflowCollectionItem[] = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const page = await client.COLLECTION_WORKFLOW_LIST({ limit, offset });
      allItems.push(...page.items);
      if (!page.hasMore) break;
      offset += page.items.length;
    }
    existing = allItems;
  } catch {
    console.warn(
      "[Workflows] Could not list workflows. The workflows plugin may not be enabled. Skipping sync.",
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

  // I5: Upserts run in parallel — no ordering dependency between workflows.
  await Promise.all(
    declaredEntries.map(async ([id, wf]) => {
      try {
        if (managed.has(id)) {
          await client.COLLECTION_WORKFLOW_UPDATE({
            id,
            data: {
              title: wf.title,
              description: wf.description,
              ...(wf.virtual_mcp_id !== undefined && {
                virtual_mcp_id: wf.virtual_mcp_id,
              }),
              steps: wf.steps,
            },
          });
        } else {
          await client.COLLECTION_WORKFLOW_CREATE({
            data: {
              id,
              title: wf.title,
              description: wf.description,
              virtual_mcp_id: wf.virtual_mcp_id,
              steps: wf.steps,
            },
          });
        }
      } catch (error) {
        console.warn(
          `[Workflows] Failed to sync workflow "${wf.title}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }),
  );

  // I5: Deletes run in parallel — orphans are independent of each other.
  await Promise.all(
    [...managed.keys()]
      .filter((id) => !declaredIds.has(id))
      .map(async (id) => {
        try {
          await client.COLLECTION_WORKFLOW_DELETE({ id });
        } catch (error) {
          console.warn(
            `[Workflows] Failed to delete orphaned workflow "${id}":`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
  );

  // I4: Record the fingerprint so identical follow-up calls are no-ops.
  workflowFingerprints.set(connectionId, fingerprint);
}

async function syncWorkflows(
  declared: WorkflowDefinition[],
  meshUrl: string,
  connectionId: string,
  token?: string,
  /** Optional client override — only used in tests to capture payloads. */
  _clientOverride?: MeshWorkflowClient,
): Promise<void> {
  // I7: Chain onto any in-flight sync for this connectionId so concurrent calls
  // never interleave LIST/CREATE/DELETE operations against the same connection.
  const previous = syncInFlight.get(connectionId) ?? Promise.resolve();
  const next = previous
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

export const Workflow = {
  sync: syncWorkflows,
  slugify,
  workflowId,
  toolId: workflowToolId,
  createClient: createMeshSelfClient,
};

// ============================================================================
// Fluent Workflow Builder
// ============================================================================

/**
 * Minimal tool shape for builder type inference.
 * Defined locally to avoid a circular import with tools.ts (which imports
 * WorkflowDefinition from this file). Includes inputSchema so the builder
 * can derive per-tool input key suggestions.
 */
type ToolLike<TId extends string = string> = {
  id: TId;
  inputSchema: ZodTypeAny;
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

  constructor(private readonly meta: Omit<WorkflowDefinition, "steps">) {}

  step<TName extends string>(
    name: TName,
    opts: StepOpts<TSteps, TTools>,
  ): WorkflowBuilder<TSteps | TName, TTools> {
    this._steps.push({ name, ...(opts as Omit<Step, "name">) });
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
    this._steps.push({
      name,
      ...(rest as Omit<Step, "name" | "forEach">),
      forEach: { ref, concurrency },
    });
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
  void tools; // runtime unused — exists purely for type inference
  return new WorkflowBuilder(meta) as unknown as WorkflowBuilder<never, TTools>;
}
