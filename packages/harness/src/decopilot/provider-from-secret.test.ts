import { describe, expect, it } from "bun:test";
import type { DecopilotSecretModelSource } from "../sources";
import { createProviderFromSecret } from "./provider-from-secret";

const secret = (providerId: string): DecopilotSecretModelSource =>
  ({
    kind: "secret",
    providerId,
    apiKey: "sk-test-unused-no-network",
    modelId: "x/y",
  }) as DecopilotSecretModelSource;

describe("createProviderFromSecret", () => {
  // Regression guard: the openrouter/deco branch once wrapped languageModel as
  // `(...args) => aiSdk.languageModel(...args)` AFTER `Object.assign` had already
  // replaced `aiSdk.languageModel` with that very wrapper — a self-referential
  // tail call. Under JSC (Bun) proper-tail-call elimination this becomes a 100%
  // CPU infinite loop (not a stack overflow), so the desktop sandbox daemon
  // wedged on every decopilot run. `languageModel(...)` must construct a model
  // synchronously and return. (A regression would hang this test — a loud,
  // CI-visible failure, since a synchronous infinite loop ignores test timeouts.)
  for (const providerId of [
    "openrouter",
    "deco",
    "llmapi",
    "openai-compatible",
  ] as const) {
    it(`${providerId}: languageModel returns a model without self-recursion`, () => {
      const provider = createProviderFromSecret(secret(providerId));
      const model = provider.aiSdk.languageModel("some-model");
      expect(model).toBeDefined();
      expect(typeof (model as { modelId?: unknown }).modelId).toBe("string");
    });
  }
});
