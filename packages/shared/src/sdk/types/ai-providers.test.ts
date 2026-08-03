import { describe, expect, test } from "bun:test";
import {
  HOSTED_PROVIDER_IDS,
  PROVIDER_IDS,
  isHostedProviderId,
} from "./ai-providers";

describe("AI provider ID boundaries", () => {
  test("recognizes every hosted provider", () => {
    for (const providerId of HOSTED_PROVIDER_IDS) {
      expect(isHostedProviderId(providerId)).toBeTrue();
    }
  });

  test.each(["claude-code", "codex", "unknown-provider"])(
    "does not recognize %s as a hosted provider",
    (providerId) => {
      expect(isHostedProviderId(providerId)).toBeFalse();
    },
  );

  test("retains native-only IDs for historical provider-key rows", () => {
    expect(PROVIDER_IDS).toContain("claude-code");
    expect(PROVIDER_IDS).toContain("codex");
  });
});
