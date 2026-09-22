import { describe, expect, it } from "bun:test";

type Node = {
  label: string;
  tappable: boolean;
  box: { x: number; y: number; width: number; height: number };
};
type Hit = { node?: Node; ambiguous?: Node[] };

/** The bin is extensionless CJS, so `require` reaches its pure helper without
 *  loading playwright — which only exists inside the sandbox image. */
const { findSemanticsByLabel } = require("./image/bin/qa-screenshot") as {
  findSemanticsByLabel: (nodes: Node[], label: string) => Hit;
};

const node = (label: string, x = 0) => ({
  label,
  tappable: true,
  box: { x, y: 0, width: 10, height: 10 },
});

describe("findSemanticsByLabel", () => {
  it("returns the single exact match", () => {
    const wanted = node("Increment");
    expect(
      findSemanticsByLabel([node("Decrement"), wanted], "Increment"),
    ).toEqual({
      node: wanted,
    });
  });

  it("reports duplicate EXACT labels as ambiguous instead of picking one", () => {
    const hit = findSemanticsByLabel(
      [node("Delete", 0), node("Delete", 99)],
      "Delete",
    );
    expect(hit.node).toBeUndefined();
    expect(hit.ambiguous).toHaveLength(2);
  });

  it("falls back to a unique case-insensitive substring", () => {
    const wanted = node("Sign in with Google");
    expect(findSemanticsByLabel([node("Cancel"), wanted], "google")).toEqual({
      node: wanted,
    });
  });

  it("reports an ambiguous substring", () => {
    const hit = findSemanticsByLabel(
      [node("Save draft"), node("Save and close")],
      "Save",
    );
    expect(hit.node).toBeUndefined();
    expect(hit.ambiguous?.map((n) => n.label)).toEqual([
      "Save draft",
      "Save and close",
    ]);
  });

  it("prefers the exact match over substrings that contain it", () => {
    const wanted = node("Save");
    expect(
      findSemanticsByLabel(
        [node("Save draft"), wanted, node("Save and close")],
        "Save",
      ),
    ).toEqual({ node: wanted });
  });

  it("returns nothing when no widget matches", () => {
    expect(findSemanticsByLabel([node("Cancel")], "Increment")).toEqual({});
  });
});
