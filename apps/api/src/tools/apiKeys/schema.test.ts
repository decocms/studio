import { describe, expect, it } from "bun:test";
import { ApiKeyCreateInputSchema } from "./schema";

/**
 * `checkApiKeyPermission` (auth/api-key-permissions.ts) rebuilds a `Set` from
 * a key's stored `permissions` allowlist on every tool call the key makes.
 * Before this bound, `API_KEY_CREATE`/`API_KEY_UPDATE` accepted an unbounded
 * `permissions` record, so a caller could mint a key whose allowlist costs
 * real CPU/memory on every future request that key makes.
 */
describe("ApiKeyCreateInputSchema permissions bound", () => {
  const base = { name: "k" };

  it("accepts a normal-sized allowlist", () => {
    const result = ApiKeyCreateInputSchema.safeParse({
      ...base,
      permissions: { self: ["ORGANIZATION_GET"], conn_abc: ["*"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects more resources than the cap", () => {
    const permissions: Record<string, string[]> = {};
    for (let i = 0; i < 1001; i++) permissions[`conn_${i}`] = ["*"];
    const result = ApiKeyCreateInputSchema.safeParse({
      ...base,
      permissions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects more actions on one resource than the cap", () => {
    const result = ApiKeyCreateInputSchema.safeParse({
      ...base,
      permissions: { self: Array.from({ length: 501 }, (_, i) => `T${i}`) },
    });
    expect(result.success).toBe(false);
  });
});
