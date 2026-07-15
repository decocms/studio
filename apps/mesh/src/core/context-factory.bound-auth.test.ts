/**
 * Unit tests for the API-key authorization wired into `createBoundAuthClient`.
 * These exercise only the in-memory decision branches (API-key allowlist / role
 * bypass), none of which call Better Auth — so a minimal stubbed `auth` is enough.
 */
import { describe, expect, it } from "bun:test";
import { createBoundAuthClient } from "./context-factory";
import type { BetterAuthInstance } from "./studio-context";

const stubAuth = { api: {} } as unknown as BetterAuthInstance;

describe("createBoundAuthClient — API-key authorization", () => {
  it("authorizes an API key SOLELY by its allowlist, ignoring the owner role", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "admin", // owner is an admin — must NOT widen the key
      permissions: { self: ["ORGANIZATION_GET"] },
      apiKeyId: "key_1",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["ORGANIZATION_GET"] })).toBe(
      true,
    );
    // The exact escalation the report found — denied even for an admin owner.
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(
      false,
    );
  });

  it("treats a wildcard key as full access (explicit full key)", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "user",
      permissions: { "*": ["*"] },
      apiKeyId: "key_2",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(true);
    expect(await client.hasPermission({ vir_x: ["SEND_MESSAGE"] })).toBe(true);
  });

  it("denies an API key with no allowlist (fail-closed)", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "owner",
      permissions: undefined,
      apiKeyId: "key_3",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["ORGANIZATION_GET"] })).toBe(
      false,
    );
  });

  it("keeps the admin/owner role bypass for a non-API-key principal", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "admin",
      permissions: { self: ["ORGANIZATION_GET"] }, // e.g. a studio JWT payload
      // no apiKeyId — not an API key principal
    });

    expect(client.isApiKeyPrincipal).toBe(false);
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(true);
  });
});
