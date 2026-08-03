import { describe, expect, test } from "bun:test";

import { getThreadAgentId } from "./utils";

describe("getThreadAgentId", () => {
  test("uses the persisted thread authority and ignores a stale run snapshot", () => {
    const thread = {
      virtual_mcp_id: "canonical-agent",
      run_config: { agent: { id: "retired-request-agent" } },
    };

    expect(getThreadAgentId(thread)).toBe("canonical-agent");
  });

  test("returns null when the thread has no persisted agent", () => {
    expect(getThreadAgentId({ virtual_mcp_id: "" })).toBeNull();
    expect(getThreadAgentId({})).toBeNull();
  });
});
