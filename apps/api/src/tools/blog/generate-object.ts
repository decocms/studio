import { generateObject, type LanguageModel, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import { retry } from "@decocms/shared/std";

/**
 * `generateObject` that retries a schema mismatch. The model occasionally
 * returns JSON that doesn't fit the Zod shape ("response did not match schema")
 * and `generateObject` throws a `NoObjectGeneratedError`; a fresh attempt almost
 * always parses, so a couple of retries turn a flaky 500 into a reliable call.
 * Only that error is retried — an auth/quota failure still surfaces at once.
 */
export function retryGenerateObject<OBJECT>(options: {
  model: LanguageModel;
  schema: z.ZodType<OBJECT>;
  system?: string;
  prompt: string;
  /**
   * A deadline for the whole call, retries included.
   *
   * Phases that share a request need one: without it a pass runs until the
   * provider answers, and the edge proxy in front hangs up first — which bills
   * the organization for an answer nobody receives.
   */
  abortSignal?: AbortSignal;
}): Promise<{ object: OBJECT }> {
  return retry(
    async () => {
      const { object } = await generateObject(options);
      return { object };
    },
    {
      maxAttempts: 3,
      minTimeout: 300,
      isRetriable: (err) => NoObjectGeneratedError.isInstance(err),
    },
  );
}

/**
 * Why a generation failed, in one line a reader can act on.
 *
 * The reason is buried two levels down — `RetryError.cause` is the
 * `NoObjectGeneratedError`, whose own `cause` holds the validation issues — so
 * logging the error itself prints "Retrying exceeded the maxAttempts (3)" and
 * nothing about which field refused. Callers here are enrichment: they log and
 * carry on, and a log that names no cause has cost whole afternoons.
 */
export function generationFailure(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  let reason = "";
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current as { message?: unknown; cause?: unknown };
    const issues = zodIssues(current);
    if (issues) return issues;
    if (typeof node.message === "string") reason = withoutValue(node.message);
    current = node.cause;
  }
  return reason || "unknown cause";
}

/** `path: code`, and nothing else — an issue list names fields, not contents. */
function zodIssues(node: unknown): string | null {
  const issues = (node as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues
    .map((issue) => {
      const { path, code } = issue as { path?: unknown[]; code?: unknown };
      return `${(path ?? []).join(".") || "<root>"}: ${String(code)}`;
    })
    .join("; ");
}

/**
 * The offending value, cut out of a message that quotes it.
 *
 * `AI_TypeValidationError` renders as `Type validation failed: Value: {…}.
 * Error message: […]` — the whole generated object, which for these tools is a
 * customer's catalogue. A log line is a shared artifact, so it gets the shape
 * of the failure and never the payload.
 */
function withoutValue(message: string): string {
  const start = message.indexOf("Value: ");
  if (start === -1) return message;
  const rest = message.indexOf("Error message: ", start);
  const tail = rest === -1 ? "" : ` ${message.slice(rest)}`;
  return `${message.slice(0, start)}<value omitted>.${tail}`;
}
