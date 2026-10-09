import { describe, expect, it } from "bun:test";
import { resolveNeedsRuntimeSetup } from "./resolve-needs-runtime-setup";

const base = {
  isThreadLocked: false,
  hasCloudProviderKeys: false,
  sandboxOnlyChats: false,
  canRunClaudeCode: false,
};

describe("resolveNeedsRuntimeSetup", () => {
  it("never gates a locked thread — its history must stay visible", () => {
    expect(resolveNeedsRuntimeSetup({ ...base, isThreadLocked: true })).toBe(
      null,
    );
    expect(
      resolveNeedsRuntimeSetup({
        ...base,
        isThreadLocked: true,
        sandboxOnlyChats: true,
      }),
    ).toBe(null);
  });

  it("gates a fresh thread without a cloud provider key", () => {
    expect(resolveNeedsRuntimeSetup(base)).toBe("provider");
  });

  it("releases a fresh thread once a cloud provider key exists", () => {
    expect(
      resolveNeedsRuntimeSetup({ ...base, hasCloudProviderKeys: true }),
    ).toBe(null);
  });

  it("ignores claude-code support while sandbox-only chats are off", () => {
    expect(
      resolveNeedsRuntimeSetup({
        ...base,
        hasCloudProviderKeys: true,
        canRunClaudeCode: false,
      }),
    ).toBe(null);
  });

  describe("sandbox-only chats", () => {
    const on = { ...base, sandboxOnlyChats: true };

    it("asks for a supported provider when only unsupported keys exist", () => {
      expect(
        resolveNeedsRuntimeSetup({ ...on, hasCloudProviderKeys: true }),
      ).toBe("claude-code-provider");
    });

    it("asks for any provider when there are no keys and no subscription", () => {
      expect(resolveNeedsRuntimeSetup(on)).toBe("provider");
    });

    it("runs on a supported key", () => {
      expect(
        resolveNeedsRuntimeSetup({
          ...on,
          hasCloudProviderKeys: true,
          canRunClaudeCode: true,
        }),
      ).toBe(null);
    });

    it("runs on the user's own Claude subscription with no org key", () => {
      expect(resolveNeedsRuntimeSetup({ ...on, canRunClaudeCode: true })).toBe(
        null,
      );
    });
  });
});
