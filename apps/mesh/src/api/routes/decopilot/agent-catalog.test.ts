import { describe, expect, test } from "bun:test";
import { buildAgentCatalog, type AgentCatalogEntry } from "./agent-catalog";

const entry = (
  id: string,
  name: string,
  description: string | null,
  status: "active" | "inactive" = "active",
): AgentCatalogEntry => ({ id, name, description, status });

describe("buildAgentCatalog", () => {
  test("returns null when there are no other active agents", () => {
    const result = buildAgentCatalog(
      [entry("vmcp_self", "Self", "Self")],
      "vmcp_self",
    );
    expect(result).toBeNull();
  });

  test("renders one CSV row per other active agent (id,name,description header)", () => {
    const result = buildAgentCatalog(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Agent A", "Does A things"),
        entry("vmcp_b", "Agent B", "Does B things"),
      ],
      "vmcp_self",
    );
    expect(result).toBe(
      `\n\n<available-agents>\n` +
        `id,name,description\n` +
        `vmcp_a,Agent A,Does A things\n` +
        `vmcp_b,Agent B,Does B things\n` +
        `</available-agents>`,
    );
  });

  test("excludes inactive agents", () => {
    const result = buildAgentCatalog(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Active A", "Active A"),
        entry("vmcp_b", "Inactive B", "Inactive B", "inactive"),
      ],
      "vmcp_self",
    );
    expect(result).toContain("vmcp_a");
    expect(result).not.toContain("vmcp_b");
  });

  test("excludes the current Virtual MCP", () => {
    const result = buildAgentCatalog(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "Agent A", "Agent A"),
      ],
      "vmcp_self",
    );
    expect(result).not.toContain("vmcp_self");
    expect(result).toContain("vmcp_a");
  });

  test("truncates descriptions over 140 characters with an ellipsis", () => {
    const long = "x".repeat(200);
    const result = buildAgentCatalog(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "Agent A", long)],
      "vmcp_self",
    );
    const expected = `${"x".repeat(139)}…`;
    expect(result).toContain(`vmcp_a,Agent A,${expected}`);
  });

  test("renders empty fields when name or description are null/empty", () => {
    const result = buildAgentCatalog(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "", null)],
      "vmcp_self",
    );
    expect(result).toContain("\nvmcp_a,,\n");
  });

  test("quotes and escapes CSV-special characters per RFC 4180", () => {
    const result = buildAgentCatalog(
      [
        entry("vmcp_self", "Self", "Self"),
        entry("vmcp_a", "A, comma", "desc"),
        entry("vmcp_b", `B "quote"`, "desc"),
        entry("vmcp_c", "C", "Has, a comma"),
        entry("vmcp_d", "D", `Has a "quote"`),
        entry("vmcp_e", "E", "Has a\nnewline"),
        entry("vmcp_f", "F", "Plain text"),
      ],
      "vmcp_self",
    );
    expect(result).toContain(`vmcp_a,"A, comma",desc`);
    expect(result).toContain(`vmcp_b,"B ""quote""",desc`);
    expect(result).toContain(`vmcp_c,C,"Has, a comma"`);
    expect(result).toContain(`vmcp_d,D,"Has a ""quote"""`);
    expect(result).toContain(`vmcp_e,E,"Has a\nnewline"`);
    expect(result).toContain(`vmcp_f,F,Plain text`);
  });

  test("starts with id,name,description header row", () => {
    const result = buildAgentCatalog(
      [entry("vmcp_self", "Self", "Self"), entry("vmcp_a", "Agent A", "x")],
      "vmcp_self",
    );
    expect(result).toContain("\n<available-agents>\nid,name,description\n");
  });
});
