import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { TASK_BOARD_COMMENT_CREATE } from "./comments";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TASK_BOARD_ITEM_RERUN } from "./rerun";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

function fieldDescription(schema: z.ZodType, field: string) {
  const json = z.toJSONSchema(schema) as {
    properties?: Record<string, { description?: string }>;
  };
  return json.properties?.[field]?.description;
}

describe("starting a Super Agent run is discoverable from the tool schemas", () => {
  for (const tool of [TASK_BOARD_ITEM_CREATE, TASK_BOARD_ITEM_UPDATE]) {
    it(`${tool.name} names the Super Agent's assignee id`, () => {
      expect(tool.description).toContain(`"${SUPER_AGENT_ASSIGNEE_ID}"`);
      expect(fieldDescription(tool.inputSchema, "assigneeId")).toContain(
        `"${SUPER_AGENT_ASSIGNEE_ID}"`,
      );
    });
  }

  it("TASK_BOARD_ITEM_RERUN says it only re-runs the Super Agent's cards", () => {
    expect(TASK_BOARD_ITEM_RERUN.description).toContain(
      "already assigned to the Super Agent",
    );
    expect(TASK_BOARD_ITEM_RERUN.description).toContain(
      `"${SUPER_AGENT_ASSIGNEE_ID}"`,
    );
  });

  it("TASK_BOARD_COMMENT_CREATE describes `body` as the comment's text", () => {
    expect(
      fieldDescription(TASK_BOARD_COMMENT_CREATE.inputSchema, "body"),
    ).toContain("text");
  });
});
