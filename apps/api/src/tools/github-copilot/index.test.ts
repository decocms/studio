import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  GITHUB_COPILOT_CONNECT,
  GITHUB_COPILOT_SHARE,
  GITHUB_COPILOT_STATUS,
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

interface FakeShare {
  providerId: string;
  userId: string;
  userName: string | null;
  sharedAt: string;
}

function ctx(
  opts: { stored?: string | null; claude?: boolean; shares?: FakeShare[] } = {},
) {
  const upsert = mock(async () => ({ linkedAt: "2026-01-01T00:00:00.000Z" }));
  // Oldest first, like the storage; shareExclusive keeps that order's winner.
  const shares: FakeShare[] = [...(opts.shares ?? [])];
  const holder = async (_org: string, providerId: string) =>
    shares.find((s) => s.providerId === providerId) ?? null;
  const shareExclusive = mock(
    async (_org: string, providerId: string, userId: string) => {
      const current = await holder(_org, providerId);
      if (current && current.userId !== userId) return current;
      if (!current) {
        shares.push({
          providerId,
          userId,
          userName: "Me",
          sharedAt: "2026-01-02T00:00:00.000Z",
        });
      }
      return holder(_org, providerId);
    },
  );
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
      claudeSubscriptions: {
        find: mock(async () =>
          opts.claude ? { linkedAt: "2026-01-01T00:00:00.000Z" } : null,
        ),
      },
      orgSharedPlans: {
        holder,
        shareExclusive,
        unshare: mock(async () => {}),
      },
    },
  } as unknown as Ctx;
  return { ctx: value, upsert, share: shareExclusive, shares };
}

const otherShare: FakeShare = {
  providerId: "github-copilot",
  userId: "user-2",
  userName: "Teammate",
  sharedAt: "2026-01-01T00:00:00.000Z",
};

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

  test("refuses while another member shares, naming them, without calling GitHub", async () => {
    const check = verify(async () => {});
    const { ctx: c, share } = ctx({
      stored: "github_pat_stored",
      shares: [otherShare],
    });
    await expect(
      GITHUB_COPILOT_SHARE.handler({ shared: true }, c),
    ).rejects.toThrow(
      "Teammate already shares their GitHub Copilot plan with this organization. Ask them to stop sharing before you share yours.",
    );
    expect(check).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  test("re-sharing your own share is a no-op that succeeds", async () => {
    verify(async () => {});
    const mine: FakeShare = { ...otherShare, userId: "user-1", userName: "Me" };
    const { ctx: c, shares } = ctx({
      stored: "github_pat_stored",
      shares: [mine],
    });
    const out = await GITHUB_COPILOT_SHARE.handler({ shared: true }, c);
    expect(shares).toHaveLength(1);
    expect(out.orgShare).toEqual({
      sharedBy: { id: "user-1", name: "Me" },
      sharedByMe: true,
      coversMe: false,
    });
  });
});

describe("GITHUB_COPILOT_STATUS orgShare", () => {
  test("covers a member who linked no plan", async () => {
    const { ctx: c } = ctx({ shares: [otherShare] });
    const out = await GITHUB_COPILOT_STATUS.handler({}, c);
    expect(out.orgShare).toEqual({
      sharedBy: { id: "user-2", name: "Teammate" },
      sharedByMe: false,
      coversMe: true,
    });
  });

  test("does not cover a member with their own Copilot or Claude plan", async () => {
    const withCopilot = ctx({ stored: "github_pat_me", shares: [otherShare] });
    expect(
      (await GITHUB_COPILOT_STATUS.handler({}, withCopilot.ctx)).orgShare
        ?.coversMe,
    ).toBe(false);
    const withClaude = ctx({ claude: true, shares: [otherShare] });
    expect(
      (await GITHUB_COPILOT_STATUS.handler({}, withClaude.ctx)).orgShare
        ?.coversMe,
    ).toBe(false);
  });

  test("is null when nobody shares", async () => {
    const { ctx: c } = ctx();
    expect((await GITHUB_COPILOT_STATUS.handler({}, c)).orgShare).toBeNull();
  });
});
