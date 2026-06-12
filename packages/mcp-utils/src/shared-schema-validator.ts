import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation";

/**
 * Shared, content-memoized JSON-schema validator for all MCP Client/Server
 * instances in the mesh.
 *
 * Why this exists — a multi-hour leak hunt: MCP SDK ≥1.27 validates tool I/O
 * with Ajv. Two compounding behaviours made this leak unboundedly under load:
 *
 *   1. Each `Client`/`Server` constructs its OWN `new AjvJsonSchemaValidator()`
 *      when none is injected. The mesh builds these per request / per Decopilot
 *      turn (proxy routes, passthrough aggregator, management server), so the
 *      Ajv instances pile up.
 *   2. `AjvJsonSchemaValidator.getValidator()` calls `ajv.compile(schema)` for
 *      every schema (MCP tool schemas have no `$id`), and Ajv keeps every
 *      compiled schema in its internal cache forever — no eviction. So the same
 *      tool schema is recompiled and retained on every request.
 *
 * Heap snapshots showed the compiled-validator codegen (the dominant growing
 * object set — `Function`/`string`/`Object` in the millions) retained via
 * `_jsonSchemaValidator → _ajv` on accumulating Client/Server instances.
 *
 * Injecting this single provider into every Client/Server makes compilation
 * happen ONCE per distinct schema across the whole process (content-keyed),
 * bounding total compiled validators to the number of distinct tool schemas
 * regardless of request volume — instead of one fresh Ajv + recompile per
 * request.
 */
class MemoizingJsonSchemaValidator implements jsonSchemaValidator {
  // A single backing Ajv instance, compiled into once per distinct schema.
  readonly #inner = new AjvJsonSchemaValidator();
  readonly #cache = new Map<string, JsonSchemaValidator<unknown>>();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const key = stableStringify(schema);
    const cached = this.#cache.get(key);
    if (cached) {
      return cached as JsonSchemaValidator<T>;
    }
    const created = this.#inner.getValidator<unknown>(schema);
    this.#cache.set(key, created);
    return created as JsonSchemaValidator<T>;
  }
}

/**
 * Stable stringify: sort object keys so two structurally-identical schemas
 * serialized with different key order still hit the same cache entry. Tool
 * schemas are small, so the recursive walk is cheap relative to Ajv compilation.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.keys(val as Record<string, unknown>)
          .sort()
          .map((k) => [k, (val as Record<string, unknown>)[k]]),
      );
    }
    return val;
  });
}

/**
 * Process-wide singleton. Pass as `jsonSchemaValidator` to every `new Client`,
 * `new Server`, and `new McpServer` so they share one bounded validator cache.
 */
export const sharedJsonSchemaValidator: jsonSchemaValidator =
  new MemoizingJsonSchemaValidator();
