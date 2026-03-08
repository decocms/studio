/**
 * @ref Resolution for Workflows
 *
 * Resolves references in step inputs:
 * - @stepName.path - Output from previous step
 * - @input.path - Workflow input
 * - @item - Current item in forEach loop
 * - @index - Current index in forEach loop
 *
 * Ported from MCP Studio.
 */

/**
 * Context for @ref resolution
 */
export interface RefContext {
  /** Outputs from completed steps: Map<stepName, output> */
  stepOutputs: Map<string, unknown>;
  /** Workflow input data */
  workflowInput: Record<string, unknown>;
  /** Current item in forEach loop (if applicable) */
  item?: unknown;
  /** Current index in forEach loop (if applicable) */
  index?: number;
  /** Current execution ID (accessible via @ctx.execution_id) */
  executionId?: string;
}

/**
 * Resolution result for a single @ref
 */
export interface RefResolution {
  value: unknown;
  error?: string;
}

/**
 * Normalize bracket notation to dot notation: `items[0].x` → `items.0.x`
 */
function normalizePath(path: string): string {
  return path.replace(/\[(\d+)\]/g, ".$1");
}

/**
 * Check if a value is an @ref string
 */
export function isAtRef(value: unknown): value is `@${string}` {
  return typeof value === "string" && value.startsWith("@");
}

/**
 * Parse an @ref string into its components
 */
export function parseAtRef(ref: `@${string}`): {
  type: "step" | "input" | "item" | "index" | "ctx";
  stepName?: string;
  path?: string;
} {
  const refStr = normalizePath(ref.substring(1)); // Remove @ prefix, normalize brackets

  // ForEach item reference: @item or @item.path or @item[0].path
  if (refStr === "item" || refStr.startsWith("item.")) {
    const path = refStr.length > 4 ? refStr.substring(5) : "";
    return { type: "item", path };
  }

  // ForEach index reference: @index
  if (refStr === "index") {
    return { type: "index" };
  }

  // Input reference: @input.path.to.value or @input[0].path
  if (refStr === "input" || refStr.startsWith("input.")) {
    const path = refStr.length > 5 ? refStr.substring(6) : "";
    return { type: "input", path };
  }

  // Execution context reference: @ctx.execution_id
  if (refStr === "ctx" || refStr.startsWith("ctx.")) {
    const path = refStr.length > 3 ? refStr.substring(4) : "";
    return { type: "ctx", path };
  }

  // Step output reference: @stepName.path or @stepName[0].path
  const parts = refStr.split(".");
  const stepName = parts[0];
  const path = parts.slice(1).join(".");

  return {
    type: "step",
    stepName,
    path,
  };
}

/**
 * Get a value from an object by path
 */
export function getValueByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;

  const keys = normalizePath(path).split(".");
  let current = obj;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];

    if (!key) {
      return undefined;
    }

    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else if (Array.isArray(current)) {
      const index = parseInt(key, 10);
      current = Number.isNaN(index) ? undefined : current[index];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Resolve a single @ref
 */
export function resolveRef(ref: `@${string}`, ctx: RefContext): RefResolution {
  try {
    const parsed = parseAtRef(ref);

    switch (parsed.type) {
      case "input": {
        const value = getValueByPath(ctx.workflowInput, parsed.path || "");
        if (value === undefined) {
          return {
            value: undefined,
            error: `Input path not found: @input.${parsed.path}`,
          };
        }
        return { value };
      }

      case "step": {
        const stepOutput = ctx.stepOutputs.get(parsed.stepName || "");
        if (stepOutput === undefined) {
          return {
            value: undefined,
            error: `Step not found or not completed: ${parsed.stepName}`,
          };
        }
        const value = getValueByPath(stepOutput, parsed.path || "");
        if (value === undefined) {
          return {
            value: undefined,
            error: `Path not found in step output: @${parsed.stepName}.${parsed.path}`,
          };
        }
        return { value };
      }

      case "item": {
        if (ctx.item === undefined) {
          return {
            value: undefined,
            error: `@item used outside of forEach context`,
          };
        }
        const value = getValueByPath(ctx.item, parsed.path || "");
        return { value };
      }

      case "index": {
        return { value: ctx.index };
      }

      case "ctx": {
        if (parsed.path === "execution_id") {
          return { value: ctx.executionId };
        }
        return {
          value: undefined,
          error: `Unknown ctx property: ${parsed.path}`,
        };
      }

      default:
        return { value: undefined, error: `Unknown reference type: ${ref}` };
    }
  } catch (error) {
    return {
      value: undefined,
      error: `Failed to resolve ${ref}: ${String(error)}`,
    };
  }
}

/**
 * Resolution result with errors
 */
export interface ResolveResult {
  resolved: unknown;
  errors?: Array<{ ref: string; error: string }>;
}

/**
 * Regex to match @refs in strings for interpolation.
 * Path segments can be identifiers, numeric indices, or bracket notation:
 *   @step.items.0.id       (dot-numeric)
 *   @step.items[0].id      (bracket notation)
 *   @step.matrix[0][1]     (consecutive brackets)
 */
const AT_REF_PATTERN =
  /@([a-zA-Z_][a-zA-Z0-9_]*(?:(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\.[0-9]+|\[[0-9]+\]))*)/g;

/**
 * Regex to match a COMPLETE @ref (entire string is one reference)
 */
const SINGLE_AT_REF_PATTERN =
  /^@([a-zA-Z_][a-zA-Z0-9_]*(?:(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\.[0-9]+|\[[0-9]+\]))*)$/;

/**
 * Check if a value is a COMPLETE @ref string (the entire value is one reference)
 */
function isSingleAtRef(value: unknown): value is `@${string}` {
  return typeof value === "string" && SINGLE_AT_REF_PATTERN.test(value);
}

/**
 * Resolve all @refs in an input object
 *
 * Handles:
 * - Direct @ref values (entire value is a reference)
 * - Interpolated @refs in strings
 * - Nested objects and arrays
 */
export function resolveAllRefs(input: unknown, ctx: RefContext): ResolveResult {
  const errors: Array<{ ref: string; error: string }> = [];

  function resolveValue(value: unknown): unknown {
    // If it's a string that IS an @ref (entire value is ONE reference)
    if (isSingleAtRef(value)) {
      const result = resolveRef(value, ctx);
      if (result.error) {
        errors.push({ ref: value, error: result.error });
      }
      return result.value;
    }

    // If it's a string that CONTAINS @refs, interpolate them
    if (typeof value === "string" && value.includes("@")) {
      const interpolated = value.replace(AT_REF_PATTERN, (match) => {
        if (isAtRef(match as `@${string}`)) {
          const result = resolveRef(match as `@${string}`, ctx);
          if (result.error) {
            errors.push({ ref: match, error: result.error });
            return match; // Keep original if resolution fails
          }
          const val = result.value;
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val);
        }
        return match;
      });
      return interpolated;
    }

    // If it's an array, resolve each element
    if (Array.isArray(value)) {
      return value.map((v) => resolveValue(v));
    }

    // If it's an object, resolve each property
    if (value !== null && typeof value === "object") {
      const resolvedObj: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        resolvedObj[key] = resolveValue(val);
      }
      return resolvedObj;
    }

    // Primitive value, return as-is
    return value;
  }

  const resolved = resolveValue(input);
  return { resolved, errors: errors.length > 0 ? errors : undefined };
}

/**
 * Get all @refs used in an input object
 */
export function extractRefs(input: unknown): string[] {
  const refs: string[] = [];

  function extract(value: unknown): void {
    if (isSingleAtRef(value)) {
      refs.push(value);
      return;
    }

    if (typeof value === "string" && value.includes("@")) {
      const matches = value.match(AT_REF_PATTERN);
      if (matches) {
        refs.push(...matches);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(extract);
      return;
    }

    if (value !== null && typeof value === "object") {
      Object.values(value).forEach(extract);
    }
  }

  extract(input);
  return refs;
}
