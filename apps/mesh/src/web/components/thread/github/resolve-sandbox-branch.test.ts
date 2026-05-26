import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveBranch,
  resolveSandboxBranchFromMap,
} from "./resolve-sandbox-branch.ts";

describe("resolveSandboxBranchFromMap", () => {
  test("returns preferred branch when present in map", () => {
    const map = {
      user1: {
        "deco/silver-plume": {
          "local-docker": {
            sandboxHandle: "h1",
            previewUrl: "http://localhost:1",
            sandboxProviderKind: "local-docker",
          },
        },
      },
    };
    expect(resolveSandboxBranchFromMap(map, "user1", "deco/silver-plume")).toBe(
      "deco/silver-plume",
    );
  });

  test("falls back to first branch with sandbox records", () => {
    const map = {
      user1: {
        "deco/other": {
          cluster: {
            sandboxHandle: "h2",
            previewUrl: "http://localhost:2",
            sandboxProviderKind: "cluster",
          },
        },
      },
    };
    expect(resolveSandboxBranchFromMap(map, "user1", null)).toBe("deco/other");
  });
});

describe("resolveEffectiveBranch", () => {
  test("prefers chat branch over other sources", () => {
    expect(
      resolveEffectiveBranch({
        chatBranch: "chat-branch",
        sandboxBranch: "sse-branch",
        sandboxMapBranch: "map-branch",
        gitCurrentBranch: "git-branch",
      }),
    ).toBe("chat-branch");
  });

  test("falls through sources in order", () => {
    expect(
      resolveEffectiveBranch({
        chatBranch: null,
        sandboxBranch: null,
        sandboxMapBranch: "map-branch",
        gitCurrentBranch: "git-branch",
      }),
    ).toBe("map-branch");
  });
});
