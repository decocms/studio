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
  it("rejects when the flag is unset — the rebuilt tools default off", async () => {
    await expect(
      assertExperimentsV2(ctxWithFlags(null), "org-a"),
    ).rejects.toThrow("experiments_v2_enabled");
  });

  it("rejects when the flag is explicitly false", async () => {
    await expect(
      assertExperimentsV2(
        ctxWithFlags({ experiments_v2_enabled: false }),
        "org-a",
      ),
    ).rejects.toThrow("experiments_v2_enabled");
  });

  it("rejects when a sibling experiments flag is on but this one is not", async () => {
    await expect(
      assertExperimentsV2(ctxWithFlags({ experiments_enabled: true }), "org-a"),
    ).rejects.toThrow("experiments_v2_enabled");
  });

  it("passes when the flag is on", async () => {
    await expect(
      assertExperimentsV2(
        ctxWithFlags({ experiments_v2_enabled: true }),
        "org-a",
      ),
    ).resolves.toBeUndefined();
  });
});
