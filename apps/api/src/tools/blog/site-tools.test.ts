import { describe, expect, test } from "bun:test";
import {
  isGroundingTool,
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
