import { z } from "zod";
import { defaultPreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import {
  isEncryptedSecretValue,
  SECRET_ENCRYPT_ACTION_KEYS,
} from "@decocms/shared/decofile";

const encryptResponseSchema = z.object({
  value: z.string().min(2).refine(isEncryptedSecretValue),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Deployments whose `DECO_CRYPTO_KEY` the production runtime shares, in order:
 * the site's `{slug}.deco.site` host, then the configured preview server.
 * Loopback hosts are skipped — a local dev key yields hex production can't decrypt.
 */
export function secretEncryptionSiteUrls(input: {
  siteSlug?: string | null;
  previewServerUrl?: string | null;
}): string[] {
  const urls = [defaultPreviewServerUrl(input.siteSlug), input.previewServerUrl]
    .filter((url): url is string => !!url)
    .filter((url) => !LOOPBACK_HOSTS.has(new URL(url).hostname));
  return [...new Set(urls)];
}

/**
 * Encrypts `value` with the site's own key via its `secrets/encrypt.ts` action
 * and returns the hex for `encrypted`. POST keeps the secret out of URLs and
 * access logs. Throws when no site answers with valid hex — callers must not
 * fall back to storing `value`.
 */
export async function encryptSiteSecret(
  value: string,
  siteUrls: string[],
): Promise<string> {
  for (const siteUrl of siteUrls) {
    for (const actionKey of SECRET_ENCRYPT_ACTION_KEYS) {
      const res = await fetch(new URL(`/live/invoke/${actionKey}`, siteUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
        cache: "no-store",
        credentials: "omit",
      }).catch(() => null);
      if (!res?.ok) continue;
      const parsed = encryptResponseSchema.safeParse(
        await res.json().catch(() => null),
      );
      if (parsed.success && parsed.data.value !== value) {
        return parsed.data.value;
      }
    }
  }
  throw new Error("Secret encryption failed");
}
