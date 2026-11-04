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
