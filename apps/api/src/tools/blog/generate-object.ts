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
  let current = err;
  let reason = "";
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    reason = current.message;
    current = current.cause;
  }
  return reason || String(err);
}
