import { describe, expect, it } from "bun:test";
import { mapListedTools } from "./fetch-tools";

describe("mapListedTools", () => {
  it("returns null for an empty tool list", () => {
    expect(mapListedTools([])).toBeNull();
  });

  it("relaxes outputSchema with additionalProperties: true regardless of transport", () => {
    // Regression: the STDIO branch used to store outputSchema verbatim while
    // HTTP/SSE relaxed it — MCP clients re-validate structuredContent with Ajv
    // (additionalProperties: false by default) and reject any extra field a
    // closed schema doesn't model.
    const [mapped] = mapListedTools([
      {
        name: "some_tool",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    ])!;

    expect(mapped!.outputSchema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
      additionalProperties: true,
    });
  });

  it("leaves outputSchema undefined when the tool doesn't declare one", () => {
    const [mapped] = mapListedTools([
      { name: "some_tool", inputSchema: { type: "object" } },
    ])!;

    expect(mapped!.outputSchema).toBeUndefined();
  });
});
