import { describe, expect, test } from "bun:test";
import type { MeshContext } from "../../core/mesh-context";
import { codexHarnessFactory } from "./index";

/**
 * Contract tests for the Codex harness factory.
 *
 * Exercising the actual streamText loop requires a working `codex`
 * app-server subprocess (the harness spawns it via
 * `ai-sdk-provider-codex-cli`), so that path is left to end-to-end /
 * resilience tests. The unit tests here verify only the factory shape —
 * id, create() return type, and stream() being a function. Task 12 will
 * own the integration coverage via the shared dispatcher.
 *
 * Provider-cleanup correctness (the try/finally around `provider.close()`)
 * is verified by code review of `index.ts` — exercising the close path
 * unit-style would require mocking `ai-sdk-provider-codex-cli`, which
 * defeats the purpose of testing the real subprocess lifecycle.
 */
describe("codexHarnessFactory", () => {
  test("has id 'codex'", () => {
    expect(codexHarnessFactory.id).toBe("codex");
  });

  test("create() returns a Harness with id 'codex' and a stream() method", () => {
    const harness = codexHarnessFactory.create({} as MeshContext);
    expect(harness.id).toBe("codex");
    expect(typeof harness.stream).toBe("function");
  });
});
