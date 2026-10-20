import { describe, expect, test } from "bun:test";
import { resolveConnectedMcpTarget } from "./connected-mcp-target";

const app = (name: string) => ({
  name,
  _meta: { ui: { resourceUri: `ui://self/${name}` } },
});

describe("resolveConnectedMcpTarget", () => {
  test("no tools means nothing to open", () => {
    expect(resolveConnectedMcpTarget([])).toBeNull();
    expect(resolveConnectedMcpTarget(undefined)).toBeNull();
  });

  test("tools but no app opens the MCP's own page", () => {
    expect(resolveConnectedMcpTarget([{ name: "SEND" }])).toEqual({
      appToolName: null,
    });
  });

  test("opens the first app, skipping plain tools before it", () => {
    expect(
      resolveConnectedMcpTarget([{ name: "SEND" }, app("BOARD"), app("CHART")]),
    ).toEqual({ appToolName: "BOARD" });
  });
});
