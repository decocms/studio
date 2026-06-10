import { describe, expect, test } from "bun:test";
import type {
  Harness,
  HarnessFactory,
  HarnessId,
  HarnessStreamInput,
  ModelsConfig,
} from "./types";
import { WORKSPACE_CWD_DEFAULT } from "./workspace-cwd";

type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

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

describe("HarnessStreamInput v2 contract", () => {
  test("has no singular modelSource", () => {
    const hasModelSource: Has<HarnessStreamInput, "modelSource"> = false;
    const input = {} as HarnessStreamInput;

    expect(hasModelSource).toBe(false);
    expect("modelSource" in input).toBe(false);
  });

  test("requires workspace.cwd", () => {
    const hasWorkspace: Has<HarnessStreamInput, "workspace"> = true;
    // Required: `undefined` must NOT be assignable to the field.
    const workspaceRequired: undefined extends HarnessStreamInput["workspace"]
      ? false
      : true = true;
    const cwd: HarnessStreamInput["workspace"]["cwd"] = WORKSPACE_CWD_DEFAULT;

    expect(hasWorkspace).toBe(true);
    expect(workspaceRequired).toBe(true);
    expect(cwd).toBe("default");
  });

  test("models slots are thinking/fast/smart/image/deepResearch, each with credentialId; no title/coding/root credentialId", () => {
    const hasTitleSlot: Has<ModelsConfig, "title"> = false;
    const hasCodingSlot: Has<ModelsConfig, "coding"> = false;
    const hasRootCredential: Has<ModelsConfig, "credentialId"> = false;
    const hasSmartSlot: Has<ModelsConfig, "smart"> = true;
    const hasThinkingCredential: Has<ModelsConfig["thinking"], "credentialId"> =
      true;
    // Per-slot credentialId is required, not optional.
    const thinkingCredentialRequired: undefined extends ModelsConfig["thinking"]["credentialId"]
      ? false
      : true = true;

    expect(hasTitleSlot).toBe(false);
    expect(hasCodingSlot).toBe(false);
    expect(hasRootCredential).toBe(false);
    expect(hasSmartSlot).toBe(true);
    expect(hasThinkingCredential).toBe(true);
    expect(thinkingCredentialRequired).toBe(true);
  });
});

describe("HarnessStreamInput sources", () => {
  test("Decopilot stream input has no decopilotRuntime backchannel", () => {
    type HasBackchannel = "decopilotRuntime" extends keyof HarnessStreamInput
      ? true
      : false;
    const hasBackchannel: HasBackchannel = false;
    const input = {} as HarnessStreamInput;

    expect(hasBackchannel).toBe(false);
    expect("decopilotRuntime" in input).toBe(false);
  });

  test("accepts mcp without embedded model secrets", () => {
    const input: Pick<HarnessStreamInput, "mcp" | "modelSources"> = {
      modelSources: {
        thinking: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-3-5-sonnet",
        },
        image: {
          kind: "secret",
          providerId: "openrouter",
          apiKey: "sk-or-test",
          modelId: "google/gemini-2.5-flash-image-preview",
        },
      },
      mcp: {
        url: "https://cluster/mcp",
        headers: { Authorization: "Bearer tok" },
        expiresAt: Date.now() + 3_600_000,
      },
    };
    expect(input.modelSources?.thinking.kind).toBe("secret");
    expect(input.modelSources?.image?.kind).toBe("secret");
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
