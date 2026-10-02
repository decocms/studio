import { describe, expect, it } from "bun:test";
import { marked } from "marked";
import { groupImageRuns } from "./markdown-image-runs";

/** Each run as the raw markdown it renders, a gallery as the list of its images. */
function runs(md: string) {
  return groupImageRuns(marked.lexer(md)).map((run) =>
    run.kind === "gallery"
      ? run.images.map((image) => image.raw)
      : run.block.raw,
  );
}

describe("groupImageRuns", () => {
  it("is empty for an empty body", () => {
    expect(runs("")).toEqual([]);
  });

  it("puts images separated by blank lines in one gallery", () => {
    expect(runs("![a](a.png)\n\n![b](b.png)\n\n![c](c.png)")).toEqual([
      ["![a](a.png)", "![b](b.png)", "![c](c.png)"],
    ]);
  });

  it("counts images sharing a paragraph as one gallery item", () => {
    expect(runs("![a](a.png) ![b](b.png)\n![c](c.png)")).toEqual([
      ["![a](a.png) ![b](b.png)\n![c](c.png)"],
    ]);
  });

  it("keeps a lone image in a gallery of its own", () => {
    expect(runs("![a](a.png)")).toEqual([["![a](a.png)"]]);
  });

  it("splits images that text stands between", () => {
    expect(runs("![a](a.png)\n\nbetween\n\n![b](b.png)")).toEqual([
      ["![a](a.png)"],
      "\n\n",
      "between",
      "\n\n",
      ["![b](b.png)"],
    ]);
  });

  it("leaves an image inside a sentence with its text", () => {
    expect(runs("see ![a](a.png)\n\n![b](b.png)")).toEqual([
      "see ![a](a.png)",
      "\n\n",
      ["![b](b.png)"],
    ]);
  });

  it("leaves a linked image and a file chip out of the gallery", () => {
    expect(
      runs(
        "![a](a.png)\n\n[![b](b.png)](https://example.com)\n\n[spec.pdf](spec.pdf)",
      ),
    ).toEqual([
      ["![a](a.png)"],
      "\n\n",
      "[![b](b.png)](https://example.com)",
      "\n\n",
      "[spec.pdf](spec.pdf)",
    ]);
  });

  it("keeps the block index of a gallery's first image, for stable keys", () => {
    const grouped = groupImageRuns(
      marked.lexer("intro\n\n![a](a.png)\n\n![b](b.png)"),
    );
    expect(grouped.map((run) => [run.kind, run.index])).toEqual([
      ["block", 0],
      ["block", 1],
      ["gallery", 2],
    ]);
  });
});
