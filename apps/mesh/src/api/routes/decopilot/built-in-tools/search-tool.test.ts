import { describe, expect, test } from "bun:test";
import {
  createSearchToolTool,
  SearchToolInputSchema,
  type SearchToolCatalogEntry,
} from "./search-tool";

const catalog: SearchToolCatalogEntry[] = [
  { id: "gmail_send_email", description: "Send an email via Gmail." },
  { id: "gmail_list_inbox", description: "List recent email inbox messages." },
  { id: "calendar_create_event", description: "Create a calendar event." },
  { id: "github_create_issue", description: "Open a GitHub issue." },
];

function execTool(entries: SearchToolCatalogEntry[]) {
  const t = createSearchToolTool(entries) as unknown as {
    execute: (input: { query: string }) => Promise<{
      results: Array<{ tool_id: string; description: string }>;
    }>;
  };
  return (query: string) => t.execute({ query });
}

describe("SearchToolInputSchema", () => {
  test("rejects an empty query", () => {
    expect(SearchToolInputSchema.safeParse({ query: "" }).success).toBe(false);
  });

  test("accepts a non-empty query", () => {
    expect(SearchToolInputSchema.safeParse({ query: "email" }).success).toBe(
      true,
    );
  });
});

describe("search_tool execute", () => {
  test("returns case-insensitive substring matches over id and description", async () => {
    const run = execTool(catalog);
    const { results } = await run("Email");
    const ids = results.map((r) => r.tool_id);
    expect(ids).toContain("gmail_send_email");
    expect(ids).toContain("gmail_list_inbox");
    expect(ids).not.toContain("calendar_create_event");
  });

  test("returns empty results when no match", async () => {
    const { results } = await execTool(catalog)("nonexistent");
    expect(results).toEqual([]);
  });

  test("caps results at 10", async () => {
    const big: SearchToolCatalogEntry[] = Array.from(
      { length: 25 },
      (_, i) => ({
        id: `tool_${i}`,
        description: "match",
      }),
    );
    const { results } = await execTool(big)("match");
    expect(results.length).toBe(10);
  });

  test("truncates descriptions over 140 characters with an ellipsis", async () => {
    const long = "x".repeat(200);
    const { results } = await execTool([
      { id: "long_tool", description: long },
    ])("long");
    expect(results[0]?.description).toBe(`${"x".repeat(139)}…`);
  });
});
