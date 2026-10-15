import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generationFailure } from "./generate-object";

/**
 * A generation failure is logged, and a log is a shared artifact.
 *
 * The chain these walk is four deep — `RetryError` wraps
 * `AI_NoObjectGeneratedError` wraps `AI_TypeValidationError` wraps `ZodError` —
 * and only the last names the field that actually refused. The third renders
 * the entire generated object into its message, which for these tools is a
 * customer's product catalogue, so reaching the fourth is both what makes the
 * line useful and what keeps the catalogue out of it.
 *
 * zod's `ZodError` is not an `Error` subclass, which is the trap: a walk
 * conditioned on `instanceof Error` stops one short and logs the payload.
 */
const CATALOGUE = JSON.stringify({
  products: [{ id: "150298", description: "SEGREDO-DO-CLIENTE-".repeat(80) }],
});

const link = (name: string, message: string, cause?: unknown) =>
  Object.assign(new Error(message), { name, cause });

const typeValidation = (cause?: unknown) =>
  link(
    "AI_TypeValidationError",
    `Type validation failed: Value: ${CATALOGUE}. Error message: [...]`,
    cause,
  );

const retried = (cause: unknown) =>
  link(
    "RetryError",
    "Retrying exceeded the maxAttempts (3).",
    link(
      "AI_NoObjectGeneratedError",
      "No object generated: response did not match schema.",
      cause,
    ),
  );

describe("generationFailure", () => {
  const zodError = new z.ZodError([
    {
      origin: "string",
      code: "too_big",
      maximum: 2048,
      inclusive: true,
      path: ["products", 2, "description"],
      message: "Too big",
    },
  ]);

  test("names the field that refused, which the wrapper never says", () => {
    expect(generationFailure(retried(typeValidation(zodError)))).toBe(
      "products.2.description: too_big",
    );
  });

  test("never carries the generated object into the log", () => {
    expect(generationFailure(retried(typeValidation(zodError)))).not.toContain(
      "SEGREDO-DO-CLIENTE",
    );
  });

  test("cuts the value out even when the issue list is unreachable", () => {
    const logged = generationFailure(retried(typeValidation()));
    expect(logged).not.toContain("SEGREDO-DO-CLIENTE");
    expect(logged).toContain("<value omitted>");
  });

  test("reports an issue per field, so a reader sees the whole shape", () => {
    const both = new z.ZodError([
      ...zodError.issues,
      {
        origin: "string",
        code: "too_big",
        maximum: 2048,
        inclusive: true,
        path: ["products", 3, "description"],
        message: "Too big",
      },
    ]);
    expect(generationFailure(retried(typeValidation(both)))).toBe(
      "products.2.description: too_big; products.3.description: too_big",
    );
  });

  test("passes a transport failure through as it is", () => {
    expect(generationFailure(link("APICallError", "401 unauthorized"))).toBe(
      "401 unauthorized",
    );
  });

  test("says something rather than nothing for a thrown non-error", () => {
    expect(generationFailure("boom")).toBe("unknown cause");
    expect(generationFailure(undefined)).toBe("unknown cause");
  });

  test("terminates on a cause that points back at itself", () => {
    const loop = link("A", "went in a circle");
    loop.cause = loop;
    expect(generationFailure(loop)).toBe("went in a circle");
  });
});
