/**
 * Parameter validation for the four methods. `params` is always an object;
 * unknown parameters are rejected, so a guard the server doesn't understand
 * never turns into an unguarded write.
 *
 * zod only checks the shape: callers keep using the raw object, because a
 * parsed copy of a record would turn an own `__proto__` key into a prototype.
 */
import { z } from "zod";
import { invalidParams } from "./errors";
import type { BlocksApplyParams, MethodName, ReadParams } from "./types";

const opaque = z.string().min(1).max(1024);

const readParams = z.strictObject({
  ref: z.string().min(1).max(255).optional(),
  ifNoneMatch: opaque.optional(),
});

const applyParams = z.strictObject({
  ref: z.string().min(1).max(255).optional(),
  requestKey: z.string().min(1).max(256).optional(),
  ifSchemaMatch: opaque.optional(),
  // Entry shapes are checked later and reported as InvalidBlock, all at once.
  set: z.record(z.string(), z.unknown()).optional(),
  delete: z.array(z.string()).optional(),
  ifMatch: z.record(z.string(), opaque.nullable()).optional(),
});

const schemas: Record<MethodName, z.ZodType> = {
  describe: z.strictObject({}),
  "schema.get": readParams,
  "blocks.list": readParams,
  "blocks.apply": applyParams,
};

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "params";
      if (issue.code === "unrecognized_keys") {
        return `unknown parameter${issue.keys.length > 1 ? "s" : ""} ${issue.keys
          .map((k) => `"${k}"`)
          .join(", ")}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Checks `params` for `method` and returns it as given (never a copy).
 * Throws Invalid params (-32602) when it doesn't fit.
 */
export function validateParams(
  method: "describe",
  params: unknown,
): Record<string, never>;
export function validateParams(
  method: "schema.get" | "blocks.list",
  params: unknown,
): ReadParams;
export function validateParams(
  method: "blocks.apply",
  params: unknown,
): BlocksApplyParams;
export function validateParams(method: MethodName, params: unknown): unknown;
export function validateParams(method: MethodName, params: unknown): unknown {
  const value = params === undefined ? {} : params;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParams("params must be an object");
  }
  const result = schemas[method].safeParse(value);
  if (!result.success) throw invalidParams(describeIssues(result.error));
  return value;
}
