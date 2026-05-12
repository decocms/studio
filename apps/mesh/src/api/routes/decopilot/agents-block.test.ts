import { describe, expect, test } from "bun:test";
import { buildAgentsBlock, type AgentsBlockEntry } from "./agents-block";

const entry = (
  id: string,
  name: string,
  description: string | null,
  status: "active" | "inactive" = "active",
): AgentsBlockEntry => ({ id, name, description, status });

describe("buildAgentsBlock", () => {
  test("returns null when there are no other active agents", () => {
    expect(
      buildAgentsBlock([entry("vmcp_self", "Self", "Self")], "vmcp_self"),
    ).toBeNull();
  });

  test("emits CSV catalog with id,name,description header", () => {
    const result = buildAgentsBlock(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Agent A", "Does A things"),
        entry("vmcp_b", "Agent B", "Does B things"),
      ],
      "vmcp_self",
    );
    expect(result).toContain("<available-agents>");
    expect(result).toContain("id,name,description");
    expect(result).toContain("vmcp_a,Agent A,Does A things");
    expect(result).toContain("vmcp_b,Agent B,Does B things");
  });

  test("excludes inactive agents and the current agent id", () => {
    const result = buildAgentsBlock(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Active", "Active"),
        entry("vmcp_b", "Inactive", "Inactive", "inactive"),
      ],
      "vmcp_self",
    );
    expect(result).toContain("vmcp_a");
    expect(result).not.toContain("vmcp_b");
    expect(result).not.toContain("vmcp_self");
  });

  test("truncates descriptions over 140 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "A", long)],
      "vmcp_self",
    );
    const expected = `${"x".repeat(139)}…`;
    expect(result).toContain(`vmcp_a,A,${expected}`);
  });

  test("quotes CSV-special characters per RFC 4180", () => {
    const result = buildAgentsBlock(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "A, comma", "desc"),
        entry("vmcp_b", `B "quote"`, "desc"),
        entry("vmcp_c", "C", "Has, a comma"),
      ],
      "vmcp_self",
    );
    expect(result).toContain(`vmcp_a,"A, comma",desc`);
    expect(result).toContain(`vmcp_b,"B ""quote""",desc`);
    expect(result).toContain(`vmcp_c,C,"Has, a comma"`);
  });

  test("includes <agents-usage> with subtask delegation guidance", () => {
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "A", "x")],
      "vmcp_self",
    );
    expect(result).toContain("<agents-usage>");
    expect(result).toContain("subtask");
    expect(result).toContain("full context");
  });
});
