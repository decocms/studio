import { describe, expect, it } from "bun:test";
import { evaluateWhereExpression } from "./list";
import type { VirtualMCPEntity } from "./schema";

const virtualMcp = {
  id: "vmcp_1",
  title: "My Virtual MCP",
  connections: [{ connection_id: "conn_1" }],
} as unknown as VirtualMCPEntity;

describe("evaluateWhereExpression", () => {
  it("treats an empty 'or' condition list as a no-op, not a vacuous false", () => {
    expect(
      evaluateWhereExpression(virtualMcp, {
        operator: "or",
        conditions: [],
      }),
    ).toBe(true);
  });

  it("treats an empty 'not' condition list as a no-op, not a vacuous true", () => {
    expect(
      evaluateWhereExpression(virtualMcp, {
        operator: "not",
        conditions: [],
      }),
    ).toBe(true);
  });

  it("still applies a non-empty 'or' normally", () => {
    expect(
      evaluateWhereExpression(virtualMcp, {
        operator: "or",
        conditions: [
          { field: ["id"], operator: "eq", value: "vmcp_2" },
          { field: ["id"], operator: "eq", value: "vmcp_1" },
        ],
      }),
    ).toBe(true);
  });
});
