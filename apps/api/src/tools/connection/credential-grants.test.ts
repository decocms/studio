import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { validateConfiguration } from "./credential-grants";

function fakeCtx(
  connections: Record<string, { organization_id: string }>,
): StudioContext {
  return {
    storage: {
      connections: {
        findById: async (id: string) => connections[id] ?? null,
      },
    },
    access: {
      check: async () => {},
    },
  } as unknown as StudioContext;
}

describe("validateConfiguration", () => {
  test("rejects a SELF value pointing at another org's self-connection", async () => {
    const ctx = fakeCtx({
      "victim-org_self": { organization_id: "victim-org" },
    });
    const state = { SELF: { value: "victim-org_self" } };

    await expect(
      validateConfiguration(
        state,
        ["SELF::CONFIGURATION_READ"],
        "caller-org",
        ctx,
      ),
    ).rejects.toThrow(/not found/i);
  });

  test("allows the caller's own self-connection without a DB lookup", async () => {
    const ctx = fakeCtx({});
    const state = { SELF: { value: "caller-org_self" } };

    await expect(
      validateConfiguration(
        state,
        ["SELF::CONFIGURATION_READ"],
        "caller-org",
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});
