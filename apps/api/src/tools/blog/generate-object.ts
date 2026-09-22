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
