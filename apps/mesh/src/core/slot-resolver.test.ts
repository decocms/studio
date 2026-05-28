/**
 * Unit tests for slot-resolver's pure-logic surface: the in-memory
 * SlotResolutionCache and the SlotUnresolvedError type.
 *
 * DB-backed resolution behavior (the `resolveSlot` query) is covered in
 * `slot-resolver.integration.test.ts`, which runs against real Postgres.
 */

import { describe, expect, it } from "bun:test";
import { SlotUnresolvedError, SlotResolutionCache } from "./slot-resolver";

describe("SlotResolutionCache", () => {
  it("returns cached result without hitting the DB on repeated calls", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_user_a", access: "user" as const };
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "different_id", access: "user" as const };
    });

    expect(result1).toEqual({ connectionId: "conn_user_a", access: "user" });
    expect(result2).toEqual({ connectionId: "conn_user_a", access: "user" });
    expect(hitCount).toBe(1);
  });

  it("caches null results too", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return null;
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_new", access: "user" as const };
    });

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(hitCount).toBe(1);
  });

  it("scopes cache by (userId, appId)", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "ga", access: "user" as const };
    });
    await cache.resolve("user_b", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "gb", access: "user" as const };
    });
    await cache.resolve("user_a", "mcp-linear", async () => {
      hitCount++;
      return { connectionId: "la", access: "user" as const };
    });

    expect(hitCount).toBe(3);
  });
});

describe("SlotUnresolvedError", () => {
  it("carries app_id for the UI to surface", () => {
    const err = new SlotUnresolvedError("mcp-github");
    expect(err.appId).toBe("mcp-github");
    expect(err.name).toBe("SlotUnresolvedError");
    expect(err.message).toContain("mcp-github");
  });
});
