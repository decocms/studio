import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  GITHUB_COPILOT_CONNECT,
  GITHUB_COPILOT_SHARE,
  normalizeCopilotToken,
} from "./index";
import { copilotTokenVerifier, verifyCopilotToken } from "./verify-token";

describe("normalizeCopilotToken", () => {
  test("trims a fine-grained token", () => {
    expect(normalizeCopilotToken("  github_pat_abc\n")).toBe("github_pat_abc");
  });

  test("rejects a classic token, which Copilot ignores", () => {
    expect(() => normalizeCopilotToken("ghp_abc")).toThrow(/fine-grained/);
  });

  test("rejects empty and multi-part input", () => {
    expect(() => normalizeCopilotToken("   ")).toThrow(/empty/);
    expect(() => normalizeCopilotToken("github_pat_a b")).toThrow(/spaces/);
  });
});

type Ctx = Parameters<typeof GITHUB_COPILOT_CONNECT.handler>[1];

function ctx(opts: { stored?: string | null } = {}) {
  const upsert = mock(async () => ({ linkedAt: "2026-01-01T00:00:00.000Z" }));
  const share = mock(async () => {});
  const value = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}) },
    storage: {
      githubCopilotSubscriptions: {
        upsert,
        find: mock(async () =>
          opts.stored ? { linkedAt: "2026-01-01T00:00:00.000Z" } : null,
        ),
        findLiveToken: mock(async () => opts.stored ?? null),
      },
      orgSharedPlans: {
        share,
        unshare: mock(async () => {}),
        list: async () => [],
      },
    },
  } as unknown as Ctx;
  return { ctx: value, upsert, share };
}

const verify = (impl: (token: string) => Promise<void>) => {
  copilotTokenVerifier.verify = mock(impl);
  return copilotTokenVerifier.verify;
};

afterEach(() => {
  copilotTokenVerifier.verify = verifyCopilotToken;
});

describe("GITHUB_COPILOT_CONNECT", () => {
  test("stores a token Copilot accepts", async () => {
    const check = verify(async () => {});
    const { ctx: c, upsert } = ctx();
    await GITHUB_COPILOT_CONNECT.handler({ token: " github_pat_ok " }, c);
    expect(check).toHaveBeenCalledWith("github_pat_ok");
    expect(upsert).toHaveBeenCalledWith({
      userId: "user-1",
      accessToken: "github_pat_ok",
    });
  });

  test("stores nothing when Copilot rejects the token", async () => {
    verify(async () => {
      throw new Error("GitHub Copilot rejected this token");
    });
    const { ctx: c, upsert } = ctx();
    await expect(
      GITHUB_COPILOT_CONNECT.handler({ token: "github_pat_bad" }, c),
    ).rejects.toThrow(/rejected this token/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("GITHUB_COPILOT_SHARE", () => {
  test("re-verifies the stored token before sharing it with the org", async () => {
    const check = verify(async () => {});
    const { ctx: c, share } = ctx({ stored: "github_pat_stored" });
    await GITHUB_COPILOT_SHARE.handler({ shared: true }, c);
    expect(check).toHaveBeenCalledWith("github_pat_stored");
    expect(share).toHaveBeenCalledTimes(1);
  });

  test("refuses to share a token that no longer works", async () => {
    verify(async () => {
      throw new Error("GitHub Copilot rejected this token");
    });
    const { ctx: c, share } = ctx({ stored: "github_pat_stale" });
    await expect(
      GITHUB_COPILOT_SHARE.handler({ shared: true }, c),
    ).rejects.toThrow(/rejected this token/);
    expect(share).not.toHaveBeenCalled();
  });

  test("stopping a share never calls GitHub", async () => {
    const check = verify(async () => {});
    const { ctx: c } = ctx({ stored: "github_pat_stored" });
    await GITHUB_COPILOT_SHARE.handler({ shared: false }, c);
    expect(check).not.toHaveBeenCalled();
  });
});
