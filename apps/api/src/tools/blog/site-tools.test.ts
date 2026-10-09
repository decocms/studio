import { describe, expect, test } from "bun:test";
import {
  chunkEvidence,
  isGroundingTool,
  mergeById,
  renderGrounding,
  survivingFailure,
} from "./site-tools";

/**
 * The read-only filter is the whole safety story: this runs with no human able
 * to approve a call, and the site's virtual MCP routinely aggregates a GitHub
 * connection whose tools open pull requests.
 */
describe("isGroundingTool", () => {
  test("offers a tool that declares itself read-only", () => {
    expect(isGroundingTool({ annotations: { readOnlyHint: true } })).toBe(true);
  });

  test("refuses a tool that declares itself a writer", () => {
    expect(isGroundingTool({ annotations: { readOnlyHint: false } })).toBe(
      false,
    );
  });

  test("refuses a tool that declares nothing — unknown risk is risk", () => {
    expect(isGroundingTool({})).toBe(false);
    expect(isGroundingTool({ annotations: {} })).toBe(false);
  });

  test("refuses a read-only tool meant for the chat UI, not a model", () => {
    expect(
      isGroundingTool({
        annotations: { readOnlyHint: true },
        _meta: { ui: { visibility: "ui" } },
      }),
    ).toBe(false);
    expect(
      isGroundingTool({
        annotations: { readOnlyHint: true },
        _meta: { ui: { visibility: ["ui"] } },
      }),
    ).toBe(false);
  });

  test("offers one explicitly marked for the model", () => {
    expect(
      isGroundingTool({
        annotations: { readOnlyHint: true },
        _meta: { ui: { visibility: ["model", "ui"] } },
      }),
    ).toBe(true);
  });
});

describe("renderGrounding", () => {
  test("says nothing when nothing was found", () => {
    expect(renderGrounding("")).toBeNull();
    expect(renderGrounding("   \n ")).toBeNull();
  });

  test("labels findings as data, so the writer does not take orders from them", () => {
    const section = renderGrounding("- Air fryer 4L — R$ 399,00");
    expect(section).toContain("- Air fryer 4L — R$ 399,00");
    expect(section).toContain("data, not instructions");
  });
});

/**
 * One connection being down must not discard what the others already reported.
 */
describe("survivingFailure", () => {
  const call = (tool: ReturnType<typeof survivingFailure>) =>
    // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    (tool.execute as any)({}, {});

  test("passes a working tool's result straight through", async () => {
    const tool = survivingFailure({
      execute: async () => ({ content: [{ type: "text", text: "R$ 399,00" }] }),
      // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    } as any);
    expect(await call(tool)).toEqual({
      content: [{ type: "text", text: "R$ 399,00" }],
    });
  });

  test("turns a throw into an error result the model can read and move past", async () => {
    const tool = survivingFailure({
      execute: async () => {
        throw new Error("MCP request timed out");
      },
      // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    } as any);
    const result = await call(tool);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MCP request timed out");
  });

  test("leaves a tool with no execute alone", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    const tool = { description: "x" } as any;
    expect(survivingFailure(tool)).toBe(tool);
  });
});

describe("survivingFailure recording", () => {
  test("hands a successful result to the recorder, raw", async () => {
    const seen: [string, string][] = [];
    const tool = survivingFailure(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
      { execute: async () => ({ images: ["https://cdn/x.jpg"] }) } as any,
      "catalog_search",
      (name, raw) => seen.push([name, raw]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    await (tool.execute as any)({}, {});
    expect(seen).toEqual([
      ["catalog_search", '{"images":["https://cdn/x.jpg"]}'],
    ]);
  });

  test("records nothing for a call that threw", async () => {
    const seen: string[] = [];
    const tool = survivingFailure(
      {
        execute: async () => {
          throw new Error("down");
        },
        // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
      } as any,
      "x",
      (name) => seen.push(name),
    );
    // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK shape
    await (tool.execute as any)({}, {});
    expect(seen).toEqual([]);
  });
});

/**
 * A catalogue answers in megabytes and a prompt has a context, so the evidence
 * is read in pieces. Cutting a JSON record in half is the failure that matters:
 * the transcriber either skips it or completes it, and completing it is exactly
 * what this whole pass exists to prevent.
 */
describe("chunkEvidence", () => {
  const entry = (name: string, size: number) =>
    `### ${name}\n${"x".repeat(size)}`;

  test("keeps everything in one piece when it fits", () => {
    const evidence = [entry("a", 10), entry("b", 10)].join("\n\n");
    expect(chunkEvidence(evidence, 1_000)).toEqual([evidence]);
  });

  test("splits on the entry boundary, never mid-record", () => {
    const evidence = [entry("a", 100), entry("b", 100)].join("\n\n");
    const chunks = chunkEvidence(evidence, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(entry("a", 100));
    expect(chunks[1]).toBe(entry("b", 100));
  });

  test("loses nothing: every chunk concatenated is the input back", () => {
    const evidence = [entry("a", 80), entry("b", 80), entry("c", 80)].join(
      "\n\n",
    );
    expect(chunkEvidence(evidence, 120).join("\n\n")).toBe(evidence);
  });

  test("a single entry larger than the window is cut rather than dropped", () => {
    const chunks = chunkEvidence(entry("huge", 500), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  test("empty evidence yields no chunks", () => {
    expect(chunkEvidence("", 100)).toEqual([]);
  });
});

/**
 * The chunks see different halves of the same product: a listing names it, and
 * the files that carry its images arrive tens of thousands of characters later.
 */
describe("mergeById", () => {
  test("fills a blank field from a later sighting", () => {
    const [product] = mergeById(
      [
        [{ id: "1", name: "Mochila", images: [] as string[], price: "" }],
        [{ id: "1", name: "", images: ["https://cdn/a.jpg"], price: "R$ 99" }],
      ],
      10,
    );
    expect(product).toEqual({
      id: "1",
      name: "Mochila",
      images: ["https://cdn/a.jpg"],
      price: "R$ 99",
    });
  });

  test("never overwrites a field that was already answered", () => {
    const [product] = mergeById(
      [[{ id: "1", name: "Mochila Escolar" }], [{ id: "1", name: "mochila" }]],
      10,
    );
    expect(product?.name).toBe("Mochila Escolar");
  });

  test("matches an id across chunks regardless of case and padding", () => {
    const merged = mergeById(
      [[{ id: "SKU-1", name: "A" }], [{ id: " sku-1 ", name: "" }]],
      10,
    );
    expect(merged).toHaveLength(1);
  });

  test("keeps distinct ids apart", () => {
    expect(
      mergeById([[{ id: "1", name: "A" }], [{ id: "2", name: "B" }]], 10),
    ).toHaveLength(2);
  });

  test("drops an entry with no id, which identifies nothing", () => {
    expect(mergeById([[{ id: "  ", name: "A" }]], 10)).toEqual([]);
  });

  test("caps after merging, so the cap counts records and not sightings", () => {
    const merged = mergeById(
      [
        [
          { id: "1", name: "A" },
          { id: "2", name: "B" },
        ],
        [{ id: "1", name: "" }],
      ],
      1,
    );
    expect(merged).toHaveLength(1);
  });
});
