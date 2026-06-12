import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

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
 *   2. Ajv's `compile()` keeps every compiled schema in its internal cache
 *      forever — no eviction — and the SDK calls it for every schema (MCP tool
 *      schemas have no `$id`). So identical tool schemas are recompiled and
 *      retained on every request.
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
 *
 * Implemented against `ajv` directly (not the SDK's `AjvJsonSchemaValidator`)
 * because that lives behind the SDK's `exports` map, which the package's
 * classic module resolution can't reach; behaviour mirrors the SDK's provider.
 */

// Mirrors the SDK's JsonSchemaValidatorResult / JsonSchemaValidator types
// structurally so the singleton is assignable to the `jsonSchemaValidator`
// option on Client/Server without importing the SDK's exports-only types.
type ValidatorResult<T> =
  | { valid: true; data: T; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };

type Validator<T> = (input: unknown) => ValidatorResult<T>;

// Match the SDK's default Ajv configuration (server/index.js → AjvJsonSchemaValidator).
function createAjv(): Ajv {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  return ajv;
}

class MemoizingJsonSchemaValidator {
  // One backing Ajv, compiled into once per distinct schema.
  readonly #ajv = createAjv();
  readonly #cache = new Map<string, ValidateFunction>();

  getValidator<T>(schema: object): Validator<T> {
    const key = stableStringify(schema);
    let compiled = this.#cache.get(key);
    if (!compiled) {
      compiled = this.#ajv.compile(schema);
      this.#cache.set(key, compiled);
    }
    const validate = compiled;
    return (input: unknown): ValidatorResult<T> => {
      if (validate(input)) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      return {
        valid: false,
        data: undefined,
        errorMessage: this.#ajv.errorsText(validate.errors),
      };
    };
  }
}

/**
 * Stable stringify: sort object keys so two structurally-identical schemas
 * serialized with different key order still hit the same cache entry. Tool
 * schemas are small, so the recursive walk is cheap relative to compilation.
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
export const sharedJsonSchemaValidator = new MemoizingJsonSchemaValidator();
