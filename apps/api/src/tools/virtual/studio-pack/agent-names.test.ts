import { describe, expect, test } from "bun:test";
import { agentManagerAgent } from "./agent-manager";
import { STUDIO_PACK_AGENT_NAMES } from "./agent-names";
import { automationManagerAgent } from "./automation-manager";
import { usageManagerAgent } from "./usage-manager";

describe("STUDIO_PACK_AGENT_NAMES", () => {
  test("stays embedded in every manager that lists Studio Pack agents", () => {
    for (const agent of [
      agentManagerAgent,
      automationManagerAgent,
      usageManagerAgent,
    ]) {
      expect(agent.instructions).toContain(STUDIO_PACK_AGENT_NAMES);
    }
  });
});
