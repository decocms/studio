import { describe, expect, test } from "bun:test";
import type { InterestsWrite } from "../../harness-deps";
import { createUpdateInterestsTool } from "./update-interests";

describe("createUpdateInterestsTool", () => {
  test("writes the full list through deps.interests.write", async () => {
    const calls: InterestsWrite[] = [];
    const tool = createUpdateInterestsTool({
      write: async (input) => {
        calls.push(input);
      },
    });
    const result = await tool.execute!(
      { interests: [{ title: "Learning Rust", summary: "started the book" }] },
      { toolCallId: "tc1", messages: [] } as never,
    );
    expect(result).toEqual({ ok: true, count: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: "",
      agentId: "",
      userId: "",
      interests: [{ title: "Learning Rust", summary: "started the book" }],
    });
  });

  test("does not import StudioContext (no ctx field)", () => {
    const tool = createUpdateInterestsTool({ write: async () => {} });
    expect(tool.description).toContain(
      "Record what the user is durably working toward",
    );
  });
});
