import { describe, expect, test } from "bun:test";
import { type Telos, telosProgress } from "./telos";

interface Goal {
  target: number;
}
interface World {
  value: number;
}

describe("telosProgress", () => {
  test("measured:false when the telos doesn't measure", async () => {
    const telos: Telos<Goal> = { charter: (g) => `reach ${g.target}` };
    expect(await telosProgress(telos, { target: 10 }, "agent-1")).toEqual({
      measured: false,
    });
  });

  test("reports satisfied + gap when the telos measures", async () => {
    const worlds = new Map<string, World>([["agent-1", { value: 4 }]]);
    const telos: Telos<Goal, World, number> = {
      charter: (g) => `reach ${g.target}`,
      measure: {
        observe: async (tenant) => worlds.get(tenant) ?? { value: 0 },
        satisfied: (s, g) => s.value >= g.target,
        gap: (s, g) => g.target - s.value,
      },
    };

    expect(await telosProgress(telos, { target: 10 }, "agent-1")).toEqual({
      measured: true,
      satisfied: false,
      gap: 6,
    });

    worlds.set("agent-1", { value: 12 });
    expect(await telosProgress(telos, { target: 10 }, "agent-1")).toEqual({
      measured: true,
      satisfied: true,
      gap: -2,
    });
  });
});
