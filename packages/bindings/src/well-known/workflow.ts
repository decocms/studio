/**
 * Workflows Well-Known Binding
 *
 * Defines the interface for workflow providers.
 * Any MCP that implements this binding can expose configurable workflows,
 * executions, step results, and events via collection bindings.
 *
 * This binding uses collection bindings for LIST and GET operations (read-only).
 */

import { z } from "zod";
import { type Binder, bindingClient, type ToolBinder } from "../core/binder";
import {
  BaseCollectionEntitySchema,
  createCollectionBindings,
} from "./collections";
export const ToolCallActionSchema = z.object({
  toolName: z
    .string()
    .describe("Name of the tool to invoke on that connection"),
  transformCode: z
    .string()
    .optional()
    .describe(`Pure TypeScript function for data transformation of the tool call result. Must be a TypeScript file that declares the Output interface and exports a default function: \`interface Output { ... } export default async function(input): Output { ... }\`
    The input will match with the tool call outputSchema. If transformCode is not provided, the tool call result will be used as the step output. 
    Providing an transformCode is recommended because it both allows you to transform the data and validate it against a JSON Schema - tools are ephemeral and may return unexpected data.`),
});
export type ToolCallAction = z.infer<typeof ToolCallActionSchema>;

export const CodeActionSchema = z.object({
  code: z.string().describe(
    `Pure TypeScript function for data transformation. Useful to merge data from multiple steps and transform it. Must be a TypeScript file that declares the Output interface and exports a default function: \`interface Output { ... } export default async function(input): Output { ... }\`
       The input is the resolved value of the references in the input field. Example: 
       {
         "input": {
          "name": "@Step_1.name",
          "age": "@Step_2.age"
         },
         "code": "export default function(input): Output { return { result: \`\${input.name} is \${input.age} years old.\` } }"
       }
      `,
  ),
});
export type CodeAction = z.infer<typeof CodeActionSchema>;

export const WaitForSignalActionSchema = z.object({
  signalName: z
    .string()
    .describe(
      "Signal name to wait for (e.g., 'approval'). Execution pauses until SEND_SIGNAL is called with this name.",
    ),
});
export type WaitForSignalAction = z.infer<typeof WaitForSignalActionSchema>;

export const StepActionSchema = z.union([
  ToolCallActionSchema.describe("Call an external tool via MCP connection. "),
  CodeActionSchema.describe(
    "Run pure TypeScript code for data transformation. Useful to merge data from multiple steps and transform it.",
  ),
  // WaitForSignalActionSchema.describe(
  //   "Pause execution until an external signal is received (human-in-the-loop)",
  // ),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

/**
 * Step Config Schema - Optional configuration for retry, timeout, and looping
 */
export const StepConfigSchema = z.object({
  maxAttempts: z
    .number()
    .optional()
    .describe("Max retry attempts on failure (default: 1, no retries)"),
  backoffMs: z
    .number()
    .optional()
    .describe("Initial delay between retries in ms (doubles each attempt)"),
  timeoutMs: z
    .number()
    .optional()
    .describe("Max execution time in ms before step fails (default: 30000)"),
  onError: z
    .enum(["fail", "continue"])
    .optional()
    .describe(
      "What to do when this step fails: 'fail' aborts the workflow, 'continue' skips the error and proceeds",
    ),
});
export type StepConfig = z.infer<typeof StepConfigSchema>;

/**
 * Step Schema - A single unit of work in a workflow
 *
 * Action types:
 * - Tool call: Invoke an external tool via MCP connection
 * - Code: Run pure TypeScript for data transformation
 * - Wait for signal: Pause until external input (human-in-the-loop)
 *
 * Data flow uses @ref syntax:
 * - @input.field → workflow input
 * - @stepName.field → output from a previous step
 * - @ctx.execution_id → current workflow execution ID
 */

type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean | Record<string, unknown>;
  additionalItems?: boolean | Record<string, unknown>;
  items?: JsonSchema;
};
const JsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
      required: z.array(z.string()).optional(),
      description: z.string().optional(),
      additionalProperties: z
        .union([z.boolean(), z.record(z.string(), z.unknown())])
        .optional(),
      additionalItems: z
        .union([z.boolean(), z.record(z.string(), z.unknown())])
        .optional(),
      items: JsonSchemaSchema.optional(),
    })
    .passthrough(),
);

/**
 * Step names that are reserved by the @ref system and cannot be used as step names.
 * These are intercepted before step lookup in the ref resolver.
 */
export const RESERVED_STEP_NAMES = ["input", "item", "index", "ctx"] as const;

export const StepSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine(
      (name) => !(RESERVED_STEP_NAMES as readonly string[]).includes(name),
      {
        message: `Step name is reserved. Reserved names: ${RESERVED_STEP_NAMES.join(", ")}`,
      },
    )
    .describe(
      "Unique identifier for this step. Other steps reference its output as @name.field",
    ),
  description: z.string().optional().describe("What this step does"),
  action: StepActionSchema,
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Data passed to the action. Use @ref for dynamic values: @input.field (workflow input), @stepName.field (previous step output), @item/@index (loop context), @ctx.execution_id (current execution ID). Example: { 'userId': '@input.user_id', 'data': '@fetch.result', 'executionId': '@ctx.execution_id' }",
    ),
  outputSchema: JsonSchemaSchema.optional().describe(
    "Optional JSON Schema describing the expected output of the step.",
  ),
  config: StepConfigSchema.optional().describe("Retry and timeout settings"),
  forEach: z
    .object({
      ref: z.string().describe("@ ref to the step to iterate over"),
      concurrency: z
        .number()
        .optional()
        .default(1)
        .describe("max parallel iterations. default is 1 (sequential)"),
    })
    .optional(),
});

export type Step = z.infer<typeof StepSchema>;

/**
 * Workflow Execution Status
 *
 * States:
 * - pending: Created but not started
 * - running: Currently executing
 * - completed: Successfully finished
 * - cancelled: Manually cancelled
 */

const WorkflowExecutionStatusEnum = z
  .enum(["enqueued", "running", "success", "error", "failed", "cancelled"])
  .default("enqueued");
export type WorkflowExecutionStatus = z.infer<
  typeof WorkflowExecutionStatusEnum
>;

/**
 * Workflow Execution Schema
 *
 * Includes lock columns and retry tracking.
 */
export const WorkflowExecutionSchema = BaseCollectionEntitySchema.extend({
  virtual_mcp_id: z
    .string()
    .describe(
      "ID of the virtual MCP (agent) that will be used to execute the workflow",
    ),
  status: WorkflowExecutionStatusEnum.describe(
    "Current status of the workflow execution",
  ),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Input data for the workflow execution"),
  output: z
    .unknown()
    .optional()
    .describe("Output data for the workflow execution"),
  completed_at_epoch_ms: z
    .number()
    .nullish()
    .describe("Timestamp of when the workflow execution completed"),
  start_at_epoch_ms: z
    .number()
    .nullish()
    .describe("Timestamp of when the workflow execution started or will start"),
  timeout_ms: z
    .number()
    .nullish()
    .describe("Timeout in milliseconds for the workflow execution"),
  deadline_at_epoch_ms: z
    .number()
    .nullish()
    .describe(
      "Deadline for the workflow execution - when the workflow execution will be cancelled if it is not completed. This is read-only and is set by the workflow engine when an execution is created.",
    ),
  error: z
    .unknown()
    .nullish()
    .describe("Error that occurred during the workflow execution"),
  completed_steps: z
    .object({
      success: z
        .array(
          z.object({
            name: z.string(),
            completed_at_epoch_ms: z.number(),
          }),
        )
        .describe("Names of the steps that were completed successfully"),
      error: z.array(z.string()).describe("Names of the steps that errored"),
    })
    .optional()
    .describe("Names of the steps that were completed and their status"),
  running_steps: z
    .array(z.string())
    .optional()
    .describe("Names of the steps that are currently running"),
});
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;

/**
 * Event Type Enum
 *
 * Event types for the unified events table:
 * - signal: External signal (human-in-the-loop)
 * - timer: Durable sleep wake-up
 * - message: Inter-workflow communication (send/recv)
 * - output: Published value (setEvent/getEvent)
 * - step_started: Observability - step began
 * - step_completed: Observability - step finished
 * - workflow_started: Workflow began execution
 * - workflow_completed: Workflow finished
 */
export const EventTypeEnum = z.enum([
  "signal",
  "timer",
  "message",
  "output",
  "step_started",
  "step_completed",
  "workflow_started",
  "workflow_completed",
]);

export type EventType = z.infer<typeof EventTypeEnum>;

/**
 * Workflow Event Schema
 *
 * Unified events table for signals, timers, messages, and observability.
 */
export const WorkflowEventSchema = BaseCollectionEntitySchema.extend({
  execution_id: z.string(),
  type: EventTypeEnum,
  name: z.string().nullish(),
  payload: z.unknown().optional(),
  visible_at: z.number().nullish(),
  consumed_at: z.number().nullish(),
  source_execution_id: z.string().nullish(),
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

/**
 * Workflow Schema - A sequence of steps that execute with data flowing between them
 *
 * Key concepts:
 * - Steps run in parallel unless they reference each other via @ref
 * - Use @ref to wire data: @input.field, @stepName.field, @item (in loops)
 * - Execution order is auto-determined from @ref dependencies
 *
 * Example: 2 parallel fetches + 1 merge step
 * {
 *   "title": "Fetch and Merge",
 *   "steps": [
 *     { "name": "fetch_users", "action": { "connectionId": "api", "toolName": "getUsers" } },
 *     { "name": "fetch_orders", "action": { "connectionId": "api", "toolName": "getOrders" } },
 *     { "name": "merge", "action": { "code": "..." }, "input": { "users": "@fetch_users.data", "orders": "@fetch_orders.data" } }
 *   ]
 * }
 * → fetch_users and fetch_orders run in parallel; merge waits for both
 */
export const WorkflowSchema = BaseCollectionEntitySchema.extend({
  description: z
    .string()
    .optional()
    .describe("Human-readable summary of what this workflow does"),

  steps: z
    .array(StepSchema)
    .describe(
      "Ordered list of steps. Execution order is auto-determined by @ref dependencies: steps with no @ref dependencies run in parallel; steps referencing @stepName wait for that step to complete.",
    ),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * WORKFLOW Collection Binding
 *
 * Collection bindings for workflows (read-only).
 * Provides LIST and GET operations for workflows.
 */
export const WORKFLOWS_COLLECTION_BINDING = createCollectionBindings(
  "workflow",
  WorkflowSchema,
);

const DEFAULT_STEP_CONFIG: StepConfig = {
  maxAttempts: 1,
  timeoutMs: 30000,
};

// export const DEFAULT_WAIT_FOR_SIGNAL_STEP: Omit<Step, "name"> = {
//   action: {
//     signalName: "approve_output",
//   },
//   outputSchema: {
//     type: "object",
//     properties: {
//       approved: {
//         type: "boolean",
//         description: "Whether the output was approved",
//       },
//     },
//   },
// };
export const DEFAULT_TOOL_STEP: Omit<Step, "name"> = {
  action: {
    toolName: "LLM_DO_GENERATE",
    transformCode: `
    interface Input { 
      
    }
    export default function(input) { return input.result }`,
  },
  input: {
    modelId: "anthropic/claude-4.5-haiku",
    prompt: "Write a haiku about the weather.",
  },

  config: DEFAULT_STEP_CONFIG,
  outputSchema: {
    type: "object",
    properties: {
      result: {
        type: "string",
        description: "The result of the step",
      },
    },
  },
};
export const DEFAULT_CODE_STEP: Step = {
  name: "Initial Step",
  action: {
    code: `
  interface Input {
    example: string;
  }

  interface Output {
    result: unknown;
  }
    
  export default async function(input: Input): Promise<Output> { 
    return {
      result: input.example
    }
  }`,
  },
  config: DEFAULT_STEP_CONFIG,
  outputSchema: {
    type: "object",
    properties: {
      result: {
        type: "string",
        description: "The result of the step",
      },
    },
    required: ["result"],
    description:
      "The output of the step. This is a JSON Schema describing the expected output of the step.",
  },
};

export const createDefaultWorkflow = (id?: string): Workflow => ({
  id: id || crypto.randomUUID(),
  title: "Default Workflow",
  description: "The default workflow for the toolkit",
  steps: [DEFAULT_CODE_STEP],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

export const WORKFLOW_EXECUTIONS_COLLECTION_BINDING = createCollectionBindings(
  "workflow_execution",
  WorkflowExecutionSchema,
);

/**
 * WORKFLOWS Binding
 *
 * Defines the interface for workflow providers.
 * Any MCP that implements this binding can provide configurable workflows.
 *
 * Required tools:
 * - WORKFLOW_LIST: List available workflows with their configurations
 * - WORKFLOW_GET: Get a single workflow by ID (includes steps and triggers)
 */
export const WORKFLOW_COLLECTIONS_BINDINGS = [
  ...WORKFLOWS_COLLECTION_BINDING,
  ...WORKFLOW_EXECUTIONS_COLLECTION_BINDING,
] as const satisfies Binder;

export const WORKFLOW_BINDING = [
  ...WORKFLOW_COLLECTIONS_BINDINGS,
] satisfies ToolBinder[];

export const WorkflowBinding = bindingClient(WORKFLOW_BINDING);

export const WORKFLOW_EXECUTION_BINDING = createCollectionBindings(
  "workflow_execution",
  WorkflowExecutionSchema,
);

/**
 * DAG (Directed Acyclic Graph) utilities for workflow step execution
 *
 * Pure TypeScript functions for analyzing step dependencies and grouping
 * steps into execution levels for parallel execution.
 *
 * Can be used in both frontend (visualization) and backend (execution).
 */

/**
 * Minimal step interface for DAG computation.
 * This allows the DAG utilities to work with any step-like object.
 */
export interface DAGStep {
  name: string;
  input?: unknown;
}

/**
 * Extract all @ref references from a value recursively.
 * Finds patterns like @stepName or @stepName.field
 *
 * @param input - Any value that might contain @ref strings
 * @returns Array of unique reference names (without @ prefix)
 */
export function getAllRefs(input: unknown): string[] {
  const refs: string[] = [];

  function traverse(value: unknown) {
    if (typeof value === "string") {
      const matches = value.match(/@(\w+)/g);
      if (matches) {
        refs.push(...matches.map((m) => m.substring(1))); // Remove @ prefix
      }
    } else if (Array.isArray(value)) {
      value.forEach(traverse);
    } else if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(traverse);
    }
  }

  traverse(input);
  return [...new Set(refs)].sort(); // Dedupe and sort for consistent results
}

/**
 * Get the dependencies of a step (other steps it references).
 * Only returns dependencies that are actual step names (filters out built-ins like "item", "index", "input").
 *
 * @param step - The step to analyze
 * @param allStepNames - Set of all step names in the workflow
 * @returns Array of step names this step depends on
 */
export function getStepDependencies(
  step: DAGStep,
  allStepNames: Set<string>,
): string[] {
  const deps: string[] = [];

  function traverse(value: unknown) {
    if (typeof value === "string") {
      // Match @stepName or @stepName.something patterns
      const matches = value.match(/@(\w+)/g);
      if (matches) {
        for (const match of matches) {
          const refName = match.substring(1); // Remove @
          // Only count as dependency if it references another step
          // (not "item", "index", "input" from forEach or workflow input)
          if (allStepNames.has(refName)) {
            deps.push(refName);
          }
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(traverse);
    } else if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(traverse);
    }
  }

  traverse(step.input);
  return [...new Set(deps)];
}

/**
 * Build edges for the DAG: [fromStep, toStep][]
 */
export function buildDagEdges(steps: Step[]): [string, string][] {
  const stepNames = new Set(steps.map((s) => s.name));
  const edges: [string, string][] = [];

  for (const step of steps) {
    const deps = getStepDependencies(step, stepNames);
    for (const dep of deps) {
      edges.push([dep, step.name]);
    }
  }

  return edges;
}

/**
 * Compute topological levels for all steps.
 * Level 0 = no dependencies on other steps
 * Level N = depends on at least one step at level N-1
 *
 * @param steps - Array of steps to analyze
 * @returns Map from step name to level number
 */
export function computeStepLevels<T extends DAGStep>(
  steps: T[],
): Map<string, number> {
  const stepNames = new Set(steps.map((s) => s.name));
  const levels = new Map<string, number>();

  // Build dependency map
  const depsMap = new Map<string, string[]>();
  for (const step of steps) {
    depsMap.set(step.name, getStepDependencies(step, stepNames));
  }

  // Compute level for each step (with memoization)
  function getLevel(stepName: string, visited: Set<string>): number {
    if (levels.has(stepName)) return levels.get(stepName)!;
    if (visited.has(stepName)) return 0; // Cycle detection

    visited.add(stepName);
    const deps = depsMap.get(stepName) || [];

    if (deps.length === 0) {
      levels.set(stepName, 0);
      return 0;
    }

    const maxDepLevel = Math.max(...deps.map((d) => getLevel(d, visited)));
    const level = maxDepLevel + 1;
    levels.set(stepName, level);
    return level;
  }

  for (const step of steps) {
    getLevel(step.name, new Set());
  }

  return levels;
}

/**
 * Group steps by their execution level.
 * Steps at the same level have no dependencies on each other and can run in parallel.
 *
 * @param steps - Array of steps to group
 * @returns Array of step arrays, where index is the level
 */
export function groupStepsByLevel<T extends DAGStep>(steps: T[]): T[][] {
  const levels = computeStepLevels(steps);
  const maxLevel = Math.max(...Array.from(levels.values()), -1);

  const grouped: T[][] = [];
  for (let level = 0; level <= maxLevel; level++) {
    const stepsAtLevel = steps.filter((s) => levels.get(s.name) === level);
    if (stepsAtLevel.length > 0) {
      grouped.push(stepsAtLevel);
    }
  }

  return grouped;
}

/**
 * Get the dependency signature for a step (for grouping steps with same deps).
 *
 * @param step - The step to get signature for
 * @returns Comma-separated sorted list of dependencies
 */
export function getRefSignature(step: DAGStep): string {
  const inputRefs = getAllRefs(step.input);
  const allRefs = [...new Set([...inputRefs])].sort();
  return allRefs.join(",");
}

/**
 * Build a dependency graph for visualization.
 * Returns edges as [fromStep, toStep] pairs.
 *
 * @param steps - Array of steps
 * @returns Array of [source, target] pairs representing edges
 */
export function buildDependencyEdges<T extends DAGStep>(
  steps: T[],
): [string, string][] {
  const stepNames = new Set(steps.map((s) => s.name));
  const edges: [string, string][] = [];

  for (const step of steps) {
    const deps = getStepDependencies(step, stepNames);
    for (const dep of deps) {
      edges.push([dep, step.name]);
    }
  }

  return edges;
}

/**
 * Validate that there are no cycles in the step dependencies.
 *
 * @param steps - Array of steps to validate
 * @returns Object with isValid and optional error message
 */
export function validateNoCycles<T extends DAGStep>(
  steps: T[],
): { isValid: boolean; error?: string } {
  const stepNames = new Set(steps.map((s) => s.name));
  const depsMap = new Map<string, string[]>();

  for (const step of steps) {
    depsMap.set(step.name, getStepDependencies(step, stepNames));
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(stepName: string, path: string[]): string[] | null {
    if (recursionStack.has(stepName)) {
      return [...path, stepName];
    }
    if (visited.has(stepName)) {
      return null;
    }

    visited.add(stepName);
    recursionStack.add(stepName);

    const deps = depsMap.get(stepName) || [];
    for (const dep of deps) {
      const cycle = hasCycle(dep, [...path, stepName]);
      if (cycle) return cycle;
    }

    recursionStack.delete(stepName);
    return null;
  }

  for (const step of steps) {
    const cycle = hasCycle(step.name, []);
    if (cycle) {
      return {
        isValid: false,
        error: `Circular dependency detected: ${cycle.join(" -> ")}`,
      };
    }
  }

  return { isValid: true };
}
