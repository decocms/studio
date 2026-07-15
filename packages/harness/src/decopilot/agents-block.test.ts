import { describe, expect, test } from "bun:test";
import { buildAgentsBlock, type AgentsBlockEntry } from "./agents-block";

const entry = (
  id: string,
  name: string,
  description: string | null,
  status: "active" | "inactive" = "active",
): AgentsBlockEntry => ({ id, name, description, status });

describe("buildAgentsBlock", () => {
  test("emits self-delegation usage (no agents table) when no other active agents", () => {
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self")],
      "vmcp_self",
    );
    // Self-subtask is always available, so usage guidance is always present...
    expect(result).toContain("<agents-usage>");
    expect(result).toContain("subtask({ prompt })");
    // ...but with no other agents to delegate to, the catalog table is omitted.
    expect(result).not.toContain("id,name,description");
    expect(result).not.toContain("vmcp_self");
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

  test("restricts the catalog to a non-empty allowlist", () => {
    const result = buildAgentsBlock(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Agent A", "Does A things"),
        entry("vmcp_b", "Agent B", "Does B things"),
      ],
      "vmcp_self",
      ["vmcp_a"],
    );
    expect(result).toContain("vmcp_a");
    expect(result).not.toContain("vmcp_b");
  });

  test("treats a null/undefined allowlist as all agents", () => {
    const agents = [
      entry("vmcp_self", "Self", "Self"),
      entry("vmcp_a", "Agent A", "Does A things"),
      entry("vmcp_b", "Agent B", "Does B things"),
    ];
    for (const allowed of [null, undefined]) {
      const result = buildAgentsBlock(agents, "vmcp_self", allowed);
      expect(result).toContain("vmcp_a");
      expect(result).toContain("vmcp_b");
    }
  });

  test("treats an empty allowlist as itself only (no catalog)", () => {
    const result = buildAgentsBlock(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Agent A", "Does A things"),
      ],
      "vmcp_self",
      [],
    );
    // No other agents permitted, but self-delegation usage stays.
    expect(result).not.toContain("id,name,description");
    expect(result).toContain("<agents-usage>");
  });

  test("omits the catalog when the allowlist excludes every other agent", () => {
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "Agent A", "x")],
      "vmcp_self",
      ["vmcp_does_not_exist"],
    );
    // No matching agents → no table, and the self-only usage must NOT dangle a
    // pointer at <available-agents> (that's what makes the model invent ids).
    expect(result).not.toContain("id,name,description");
    expect(result).not.toContain("<available-agents>");
    expect(result).toContain("<agents-usage>");
    expect(result).toContain("NEVER pass agent_id");
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

  test("documents ephemeral delegation when only a concrete connection is available", () => {
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self")],
      "vmcp_self",
      undefined,
      ["conn_orders"],
    );

    expect(result).not.toContain("<available-agents>");
    expect(result).toContain("<available-connections>");
    expect(result).toContain("ephemeral subagent");
    expect(result).not.toContain("NEVER pass agent_id");
  });

  test("applies the delegation allowlist to concrete connection ids", () => {
    const result = buildAgentsBlock(
      [entry("vmcp_self", "Self", "Self")],
      "vmcp_self",
      [],
      ["conn_orders"],
    );

    expect(result).toContain("NEVER pass agent_id");
    expect(result).not.toContain("ephemeral subagent");
  });
});
