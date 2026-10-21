import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import { readSubscriptionUsage } from "./client";

const previousSettings = (() => {
  try {
    return getSettings();
  } catch {
    return null;
  }
})();
setGlobalSettings(resolveConfig({}));
afterAll(() => {
  if (previousSettings) setGlobalSettings(previousSettings);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CLAUDE_USAGE_BODY = {
  five_hour: { utilization: 42, resets_at: "2026-01-01T00:00:00Z" },
};

describe("readSubscriptionUsage", () => {
  it("retries a transient 503 instead of reporting usage unavailable", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 503 });
      return new Response(JSON.stringify(CLAUDE_USAGE_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    const usage = await readSubscriptionUsage(
      "claude",
      "org-1",
      "user-1",
      "token",
    );

    expect(calls).toBe(2);
    expect(usage.status).toBe("available");
    expect(usage.windows[0]?.usedPercent).toBe(42);
  });

  it("gives up after repeated 5xx responses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;

    const usage = await readSubscriptionUsage(
      "claude",
      "org-2",
      "user-1",
      "token",
    );

    expect(calls).toBe(2);
    expect(usage.status).toBe("unavailable");
    expect(usage.reason).toBe("provider_error");
  });
});
