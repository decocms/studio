import { createHash } from "node:crypto";
import { z } from "zod";
import { readBoundedText } from "@/lib/bounded-text";
import { createTtlLruCache } from "@/lib/ttl-lru-cache";
import { getSettings } from "@/settings";
import { retry } from "@decocms/shared/std";
import {
  parseSubscriptionUsage,
  type SubscriptionProvider,
  type SubscriptionUsage,
} from "./schema";

/** Thrown for a 5xx upstream status, so `retry` treats it as transient. */
class TransientUpstreamError extends Error {}

const cache = createTtlLruCache<{
  result: Promise<SubscriptionUsage>;
  expiresAt: number;
}>({ ttlMs: 600_000, maxSize: 500 });
const codexAuth = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

export function unavailableUsage(
  reason: SubscriptionUsage["reason"],
  now = new Date(),
): SubscriptionUsage {
  return {
    status: "unavailable",
    reason,
    checkedAt: now.toISOString(),
    retryAt: null,
    limitReached: null,
    windows: [],
  };
}

async function fetchUsage(
  provider: SubscriptionProvider,
  credential: string,
): Promise<SubscriptionUsage> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "codex") {
    let auth: z.infer<typeof codexAuth>;
    try {
      auth = codexAuth.parse(JSON.parse(credential));
    } catch {
      return unavailableUsage("authorization");
    }
    headers.Authorization = `Bearer ${auth.tokens.access_token}`;
    headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  } else {
    headers.Authorization = `Bearer ${credential}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }
  const settings = getSettings();
  const url =
    provider === "codex" ? settings.codexUsageUrl : settings.claudeUsageUrl;
  try {
    const response = await retry(
      async () => {
        const res = await fetch(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (res.status >= 500) {
          await res.body?.cancel().catch(() => {});
          throw new TransientUpstreamError(`upstream status ${res.status}`);
        }
        return res;
      },
      {
        maxAttempts: 2,
        minTimeout: 300,
        maxTimeout: 1000,
        isRetriable: (err) =>
          err instanceof TransientUpstreamError ||
          !(err instanceof DOMException),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return unavailableUsage("authorization");
      if (response.status === 403) return unavailableUsage("permission");
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(600, Math.max(60, seconds))
            : 300;
        return {
          ...unavailableUsage("rate_limited"),
          retryAt: new Date(Date.now() + delay * 1000).toISOString(),
        };
      }
      return unavailableUsage("provider_error");
    }
    try {
      return parseSubscriptionUsage(
        provider,
        JSON.parse(await readBoundedText(response, 65536)),
        new Date(),
      );
    } catch {
      return unavailableUsage("invalid_response");
    }
  } catch {
    return unavailableUsage("provider_error");
  }
}

export async function readSubscriptionUsage(
  provider: SubscriptionProvider,
  organizationId: string,
  userId: string,
  credential: string,
): Promise<SubscriptionUsage> {
  const digest = createHash("sha256").update(credential).digest("hex");
  const key = JSON.stringify([provider, organizationId, userId, digest]);
  const found = cache.get(key);
  if (found && found.expiresAt > Date.now()) return found.result;
  // Coalesce callers and apply a cooldown even to failures. Raw tokens and
  // upstream error bodies never enter the cache or the tool response.
  const entry = {
    result: fetchUsage(provider, credential),
    expiresAt: Date.now() + 60_000,
  };
  cache.set(key, entry);
  const result = await entry.result;
  if (result.retryAt) entry.expiresAt = new Date(result.retryAt).getTime();
  return result;
}
