import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { resolvePlanCredential } from "./plan-credential";

function ctx(opts: {
  shared?: Array<{
    providerId: string;
    userId: string;
    userName?: string | null;
  }>;
  claude?: Record<string, string>;
  copilot?: Record<string, string | Error>;
}): StudioContext {
  const tokens = (map: Record<string, string | Error> = {}) => ({
    findLiveToken: async (userId: string) => {
      const value = map[userId];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
  });
  return {
    storage: {
      orgSharedPlans: { list: async () => opts.shared ?? [] },
      claudeSubscriptions: tokens(opts.claude),
      githubCopilotSubscriptions: tokens(opts.copilot),
    },
  } as unknown as StudioContext;
}

describe("resolvePlanCredential", () => {
  test("the user's own plan outranks a plan shared with the org", async () => {
    const resolved = await resolvePlanCredential(
      ctx({
        shared: [
          { providerId: "github-copilot", userId: "admin", userName: "Admin" },
        ],
        copilot: { admin: "github_pat_admin", me: "github_pat_me" },
      }),
      "org",
      "me",
    );
    expect(resolved).toEqual({
      providerId: "github-copilot",
      apiKey: "github_pat_me",
    });
  });

  test("any own plan, Claude included, outranks a shared Copilot plan", async () => {
    expect(
      await resolvePlanCredential(
        ctx({
          shared: [{ providerId: "github-copilot", userId: "admin" }],
          claude: { me: "sk-ant-oat-me" },
          copilot: { admin: "github_pat_admin" },
        }),
        "org",
        "me",
      ),
    ).toEqual({ providerId: "claude-subscription", apiKey: "sk-ant-oat-me" });
  });

  test("a member without a plan uses the org's shared plan, tagged with its owner", async () => {
    // Whose plan it is travels with it, so a failure can name the owner.
    expect(
      await resolvePlanCredential(
        ctx({
          shared: [
            {
              providerId: "github-copilot",
              userId: "admin",
              userName: "Admin",
            },
          ],
          copilot: { admin: "github_pat_admin" },
        }),
        "org",
        "me",
      ),
    ).toEqual({
      providerId: "github-copilot",
      apiKey: "github_pat_admin",
      sharedBy: { userId: "admin", userName: "Admin" },
    });
  });

  test("the sharer's own runs never carry sharedBy", async () => {
    expect(
      await resolvePlanCredential(
        ctx({
          shared: [{ providerId: "github-copilot", userId: "me" }],
          copilot: { me: "github_pat_me" },
        }),
        "org",
        "me",
      ),
    ).toEqual({ providerId: "github-copilot", apiKey: "github_pat_me" });
  });

  test("a share whose token is gone or broken falls through to the next share", async () => {
    expect(
      await resolvePlanCredential(
        ctx({
          shared: [
            { providerId: "github-copilot", userId: "gone" },
            { providerId: "github-copilot", userId: "rotated" },
            { providerId: "github-copilot", userId: "ok", userName: "Ok" },
          ],
          copilot: {
            rotated: new Error("decrypt failed"),
            ok: "github_pat_ok",
          },
        }),
        "org",
        "me",
      ),
    ).toEqual({
      providerId: "github-copilot",
      apiKey: "github_pat_ok",
      sharedBy: { userId: "ok", userName: "Ok" },
    });
  });

  test("no plan anywhere leaves the run on the org's model key", async () => {
    expect(await resolvePlanCredential(ctx({}), "org", "me")).toBeNull();
  });
});
