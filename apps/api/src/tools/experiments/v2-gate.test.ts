import { describe, expect, it, mock } from "bun:test";
import { assertExperimentsV2 } from "./v2-gate";

function ctxWithFlags(flags: Record<string, unknown> | null) {
  return {
    storage: {
      organizationSettings: {
        get: mock(async (organizationId: string) => ({
          organizationId,
          flags,
        })),
      },
    },
  } as unknown as Parameters<typeof assertExperimentsV2>[0];
}

describe("assertExperimentsV2", () => {
  it("rejects when both flags are unset", async () => {
    await expect(
      assertExperimentsV2(ctxWithFlags(null), "org-a"),
    ).rejects.toThrow("experiments_enabled");
  });

  it("rejects when v2 is on but v1 is off", async () => {
    await expect(
      assertExperimentsV2(
        ctxWithFlags({ experiments_v2_enabled: true }),
        "org-a",
      ),
    ).rejects.toThrow("experiments_enabled");
  });

  it("rejects when v1 is on but v2 is off", async () => {
    await expect(
      assertExperimentsV2(ctxWithFlags({ experiments_enabled: true }), "org-a"),
    ).rejects.toThrow("experiments_v2_enabled");
  });

  it("passes when both flags are on", async () => {
    await expect(
      assertExperimentsV2(
        ctxWithFlags({
          experiments_enabled: true,
          experiments_v2_enabled: true,
        }),
        "org-a",
      ),
    ).resolves.toBeUndefined();
  });
});
