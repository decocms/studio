import { describe, expect, test } from "bun:test";
import { isGroundingTool, renderGrounding } from "./site-tools";

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
