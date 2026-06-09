import { describe, expect, test } from "bun:test";
import type {
  Harness,
  HarnessFactory,
  HarnessId,
  HarnessStreamInput,
} from "./types";

describe("Harness types", () => {
  test("HarnessId union covers the three v1 harnesses", () => {
    const ids: HarnessId[] = ["decopilot", "claude-code", "codex"];
    expect(ids.length).toBe(3);
  });

  test("Harness shape is { id, stream() }", () => {
    // Compile-only: if the interface drifts, this fails to type-check.
    const stub: Harness = {
      id: "decopilot",
      // biome-ignore lint/correctness/useYield: stub
      async *stream(_input: HarnessStreamInput) {},
    };
    expect(stub.id).toBe("decopilot");
  });

  test("HarnessFactory shape is { id, create(ctx) }", () => {
    const factory: HarnessFactory = {
      id: "decopilot",
      create: () => ({
        id: "decopilot",
        // biome-ignore lint/correctness/useYield: stub
        async *stream(_input: HarnessStreamInput) {},
      }),
    };
    expect(factory.id).toBe("decopilot");
    expect(typeof factory.create).toBe("function");
  });
});

/**
 * Verify the mcp.modelSecret field is structurally optional — a
 * HarnessStreamInput WITHOUT it (cluster path) and one WITH it (desktop path)
 * must both satisfy the type. This test prevents regressions where a required
 * field is accidentally added.
 */
describe("HarnessStreamInput.mcp.modelSecret", () => {
  test("accepts mcp without modelSecret (cluster path)", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "https://cluster/mcp",
      headers: { Authorization: "Bearer tok" },
      expiresAt: Date.now() + 3_600_000,
    };
    expect(mcp.modelSecret).toBeUndefined();
  });

  test("accepts mcp with modelSecret (desktop decopilot path)", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "https://cluster/mcp",
      headers: { Authorization: "Bearer tok" },
      expiresAt: Date.now() + 3_600_000,
      modelSecret: {
        providerId: "anthropic",
        apiKey: "sk-ant-test",
      },
    };
    expect(mcp.modelSecret?.providerId).toBe("anthropic");
    expect(mcp.modelSecret?.apiKey).toBe("sk-ant-test");
  });

  test("modelSecret may carry baseUrl and extraHeaders", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "",
      headers: {},
      expiresAt: 0,
      modelSecret: {
        providerId: "openai-compatible",
        apiKey: "sk-test",
        baseUrl: "https://litellm.example.com/v1",
        extraHeaders: { "x-custom": "value" },
      },
    };
    expect(mcp.modelSecret?.baseUrl).toBe("https://litellm.example.com/v1");
    expect(mcp.modelSecret?.extraHeaders?.["x-custom"]).toBe("value");
  });
});
