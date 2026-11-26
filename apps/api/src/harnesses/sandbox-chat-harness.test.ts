import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { sandboxChatHarness } from "./sandbox-only-chats";

function ctx(opts: {
  codexFlag?: boolean;
  keys?: string[];
  linkedChatGpt?: string[];
}): StudioContext {
  return {
    storage: {
      organizationSettings: {
        get: async () => ({
          flags:
            opts.codexFlag === undefined
              ? {}
              : { chat_harness_codex: opts.codexFlag },
        }),
      },
      aiProviderKeys: {
        list: async () =>
          (opts.keys ?? []).map((providerId) => ({ providerId })),
      },
      codexSubscriptions: {
        findLiveToken: async (userId: string) =>
          opts.linkedChatGpt?.includes(userId) ? "auth_example" : null,
      },
    },
  } as unknown as StudioContext;
}

describe("sandboxChatHarness", () => {
  test("stays on Claude Code while the org has not turned Codex on", async () => {
    expect(
      await sandboxChatHarness(
        ctx({ keys: ["openai-compatible"], linkedChatGpt: ["me"] }),
        "org",
        "me",
      ),
    ).toBe("claude-code");
  });

  test("runs Codex for a member who linked ChatGPT", async () => {
    expect(
      await sandboxChatHarness(
        ctx({ codexFlag: true, keys: ["deco"], linkedChatGpt: ["me"] }),
        "org",
        "me",
      ),
    ).toBe("codex");
  });

  test("keeps members on the deco gateway on Claude Code", async () => {
    expect(
      await sandboxChatHarness(
        ctx({ codexFlag: true, keys: ["deco"], linkedChatGpt: ["owner"] }),
        "org",
        "me",
      ),
    ).toBe("claude-code");
  });

  test("runs Codex for everyone on an org Responses API key", async () => {
    for (const key of ["openai-compatible", "openrouter"]) {
      expect(
        await sandboxChatHarness(
          ctx({ codexFlag: true, keys: ["deco", key] }),
          "org",
          "me",
        ),
      ).toBe("codex");
    }
  });

  test("stays on Claude Code without a user to check", async () => {
    expect(
      await sandboxChatHarness(
        ctx({ codexFlag: true, keys: ["openai-compatible"] }),
        "org",
        undefined,
      ),
    ).toBe("claude-code");
  });
});
