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
