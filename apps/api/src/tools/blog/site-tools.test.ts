import { describe, expect, test } from "bun:test";
import { renderGrounding } from "./site-tools";

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
