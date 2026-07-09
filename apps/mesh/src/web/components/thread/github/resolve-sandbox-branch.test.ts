import { describe, expect, test } from "bun:test";
import type { SandboxMap } from "@decocms/mesh-sdk";
import {
  resolveEffectiveBranch,
  resolveSandboxBranchFromMap,
} from "./resolve-sandbox-branch.ts";

const sandboxMapFixture = {
  user1: {
    "deco/silver-plume": {
      "user-desktop": {
        sandboxHandle: "h1",
        previewUrl: "http://localhost:1",
        sandboxProviderKind: "user-desktop" as const,
      },
    },
  },
} satisfies SandboxMap;

const fallbackMapFixture = {
  user1: {
    "deco/other": {
      "agent-sandbox": {
        sandboxHandle: "h2",
        previewUrl: "http://localhost:2",
        sandboxProviderKind: "agent-sandbox" as const,
      },
    },
  },
} satisfies SandboxMap;

describe("resolveSandboxBranchFromMap", () => {
  test("returns preferred branch when present in map", () => {
    expect(
      resolveSandboxBranchFromMap(
        sandboxMapFixture,
        "user1",
        "deco/silver-plume",
      ),
    ).toBe("deco/silver-plume");
  });

  test("falls back to first branch with sandbox records", () => {
    expect(resolveSandboxBranchFromMap(fallbackMapFixture, "user1", null)).toBe(
      "deco/other",
    );
  });

  test("returns prefer as-is when userId is missing", () => {
    expect(
      resolveSandboxBranchFromMap(sandboxMapFixture, undefined, "deco/pref"),
    ).toBe("deco/pref");
  });

  test("returns null when userId is missing and no prefer given", () => {
    expect(
      resolveSandboxBranchFromMap(sandboxMapFixture, undefined),
    ).toBeNull();
  });

  test("returns prefer as-is when user has no sandbox map entry", () => {
    expect(
      resolveSandboxBranchFromMap(
        sandboxMapFixture,
        "unknown-user",
        "deco/pref",
      ),
    ).toBe("deco/pref");
  });

  test("skips branches with no sandbox kinds when scanning for a fallback", () => {
    const mapWithEmptyEntry = {
      user1: {
        "deco/empty": {},
        "deco/other": {
          "agent-sandbox": {
            sandboxHandle: "h2",
            previewUrl: "http://localhost:2",
            sandboxProviderKind: "agent-sandbox" as const,
          },
        },
      },
    } satisfies SandboxMap;

    expect(resolveSandboxBranchFromMap(mapWithEmptyEntry, "user1", null)).toBe(
      "deco/other",
    );
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

  test("prefers sandbox branch over map and git branches", () => {
    expect(
      resolveEffectiveBranch({
        chatBranch: null,
        sandboxBranch: "sse-branch",
        sandboxMapBranch: "map-branch",
        gitCurrentBranch: "git-branch",
      }),
    ).toBe("sse-branch");
  });

  test("returns null when every source is null", () => {
    expect(
      resolveEffectiveBranch({
        chatBranch: null,
        sandboxBranch: null,
        sandboxMapBranch: null,
        gitCurrentBranch: null,
      }),
    ).toBeNull();
  });
});
