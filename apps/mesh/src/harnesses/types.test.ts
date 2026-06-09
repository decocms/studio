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

describe("HarnessStreamInput sources", () => {
  test("accepts mcp without embedded model secrets", () => {
    const input: Pick<HarnessStreamInput, "mcp" | "modelSource"> = {
      modelSource: {
        kind: "secret",
        providerId: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-3-5-sonnet",
      },
      mcp: {
        url: "https://cluster/mcp",
        headers: { Authorization: "Bearer tok" },
        expiresAt: Date.now() + 3_600_000,
      },
    };
    expect(input.modelSource?.kind).toBe("secret");
    expect(input.mcp.url).toBe("https://cluster/mcp");
  });

  test("accepts an explicit HTTP MCP source", () => {
    const input: Pick<HarnessStreamInput, "mcp" | "mcpSource"> = {
      mcp: {
        url: "https://cluster/mcp",
        headers: { Authorization: "Bearer tok" },
        expiresAt: Date.now() + 3_600_000,
      },
      mcpSource: {
        kind: "http",
        url: "https://cluster/mcp",
        headers: { Authorization: "Bearer tok" },
        expiresAt: Date.now() + 3_600_000,
      },
    };
    expect(input.mcpSource).toBeDefined();
    if (!input.mcpSource) throw new Error("missing mcpSource");
    expect(input.mcpSource.kind).toBe("http");
  });
});
