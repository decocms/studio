import { describe, expect, test } from "bun:test";
import {
  assertThreadRoutingUpdateAllowed,
  changesThreadRouting,
} from "./runtime-lock";

describe("assertThreadRoutingUpdateAllowed", () => {
  test("allows routing changes before routing is claimed", () => {
    expect(() =>
      assertThreadRoutingUpdateAllowed(
        {
          routing_locked_at: null,
          virtual_mcp_id: "agent-a",
          branch: "main",
        },
        { virtual_mcp_id: "agent-b", branch: "feature" },
      ),
    ).not.toThrow();
  });

  test("allows idempotent routing values on a claimed thread", () => {
    expect(() =>
      assertThreadRoutingUpdateAllowed(
        {
          routing_locked_at: "2026-08-04T12:00:00.000Z",
          virtual_mcp_id: "agent-a",
          branch: "main",
        },
        { virtual_mcp_id: "agent-a", branch: "main" },
      ),
    ).not.toThrow();
  });

  test("rejects changing the agent on a claimed thread", () => {
    expect(() =>
      assertThreadRoutingUpdateAllowed(
        {
          routing_locked_at: "2026-08-04T12:00:00.000Z",
          virtual_mcp_id: "agent-a",
          branch: "main",
        },
        { virtual_mcp_id: "agent-b" },
      ),
    ).toThrow("Cannot change the agent after this chat has started");
  });

  test("rejects changing or clearing the branch on a claimed thread", () => {
    for (const branch of ["feature", null]) {
      expect(() =>
        assertThreadRoutingUpdateAllowed(
          {
            routing_locked_at: "2026-08-04T12:00:00.000Z",
            virtual_mcp_id: "agent-a",
            branch: "main",
          },
          { branch },
        ),
      ).toThrow("Cannot change the branch after this chat has started");
    }
  });

  test("distinguishes routing changes from omitted or idempotent values", () => {
    const current = { virtual_mcp_id: "agent-a", branch: "main" };
    expect(changesThreadRouting(current, {})).toBe(false);
    expect(
      changesThreadRouting(current, {
        virtual_mcp_id: "agent-a",
        branch: "main",
      }),
    ).toBe(false);
    expect(changesThreadRouting(current, { virtual_mcp_id: "agent-b" })).toBe(
      true,
    );
    expect(changesThreadRouting(current, { branch: null })).toBe(true);
  });
});
