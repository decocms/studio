import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { rankTools } from "./gateway";

const tool = (name: string, description = ""): Tool => ({
  name,
  description,
  inputSchema: { type: "object" },
});

const github = [
  tool("search_pull_requests", "Search pull requests across repositories"),
  tool("get_file_contents", "Read a file"),
];

describe("rankTools", () => {
  it("collapses the same tool offered by several connections into one hit", () => {
    const hits = rankTools(
      "pull request",
      [
        { connection: { id: "c1", title: "GitHub" }, tools: github },
        { connection: { id: "c2", title: "GitHub" }, tools: github },
      ],
      10,
      false,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("search_pull_requests");
    expect(hits[0]!.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(hits[0]!.inputSchema).toBeUndefined();
  });

  it("ranks a name match above a description-only match and honours the limit", () => {
    const hits = rankTools(
      "orders",
      [
        {
          connection: { id: "v", title: "VTEX" },
          tools: [
            tool("GET_PRODUCT", "Product used in orders"),
            tool("LIST_ORDERS", "List"),
            tool("GET_SKU", "Unrelated"),
          ],
        },
      ],
      1,
      true,
    );
    expect(hits.map((h) => h.name)).toEqual(["LIST_ORDERS"]);
    expect(hits[0]!.inputSchema).toEqual({ type: "object" });
  });

  it("returns nothing for a query with no usable words", () => {
    expect(
      rankTools(
        "?",
        [{ connection: { id: "c", title: "x" }, tools: github }],
        5,
        false,
      ),
    ).toEqual([]);
  });
});
