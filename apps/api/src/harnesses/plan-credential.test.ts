import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { resolvePlanCredential } from "./plan-credential";

function ctx(opts: {
  shared?: Array<{ providerId: string; userId: string }>;
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
  test("a Copilot plan shared with the org outranks the user's own plans", async () => {
    const resolved = await resolvePlanCredential(
      ctx({
        shared: [{ providerId: "github-copilot", userId: "admin" }],
        claude: { me: "sk-ant-oat-me" },
        copilot: { admin: "github_pat_admin", me: "github_pat_me" },
      }),
      "org",
      "me",
    );
    expect(resolved).toEqual({
      providerId: "github-copilot",
      apiKey: "github_pat_admin",
    });
  });

  test("a share whose token is gone or broken falls through to the user's own", async () => {
    expect(
      await resolvePlanCredential(
        ctx({
          shared: [
            { providerId: "github-copilot", userId: "gone" },
            { providerId: "github-copilot", userId: "rotated" },
          ],
          claude: { me: "sk-ant-oat-me" },
          copilot: { rotated: new Error("decrypt failed") },
        }),
        "org",
        "me",
      ),
    ).toEqual({ providerId: "claude-subscription", apiKey: "sk-ant-oat-me" });
  });

  test("no plan anywhere leaves the run on the org's model key", async () => {
    expect(await resolvePlanCredential(ctx({}), "org", "me")).toBeNull();
  });
});
