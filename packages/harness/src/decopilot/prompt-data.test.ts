import { describe, expect, test } from "bun:test";
import type { HarnessStreamInput } from "../types";

// Compile-time + runtime check that the three pre-resolved prompt-data
// blocks are first-class, serializable fields on the wire input.
describe("HarnessStreamInput.userContext (pre-resolved prompt data)", () => {
  test("accepts a fully-populated userContext block", () => {
    const userContext: NonNullable<HarnessStreamInput["userContext"]> = {
      recentThreads: {
        total: 3,
        threads: [
          { id: "t1", title: "Past chat", updated_at: "2026-06-01T00:00:00Z" },
        ],
      },
      interests: [{ title: "Ship harness", summary: "Extract the package" }],
      agents: [
        {
          id: "vir_b",
          name: "Agent B",
          description: "sibling",
          status: "active",
        },
      ],
    };
    expect(userContext.interests?.[0]?.title).toBe("Ship harness");
    expect(userContext.agents?.[0]?.status).toBe("active");
    expect(userContext.recentThreads?.threads[0]?.updated_at).toBe(
      "2026-06-01T00:00:00Z",
    );
  });

  test("every sub-block is independently optional", () => {
    const empty: NonNullable<HarnessStreamInput["userContext"]> = {};
    expect(empty.recentThreads).toBeUndefined();
    expect(empty.interests).toBeUndefined();
    expect(empty.agents).toBeUndefined();
  });
});
