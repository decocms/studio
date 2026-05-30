import { describe, expect, test } from "bun:test";
import type { SandboxMap } from "@decocms/mesh-sdk";
import {
  resolveEffectiveBranch,
  resolveSandboxBranchFromMap,
} from "./resolve-sandbox-branch.ts";

const sandboxMapFixture = {
  user1: {
    "deco/silver-plume": {
      "local-docker": {
        sandboxHandle: "h1",
        previewUrl: "http://localhost:1",
        sandboxProviderKind: "local-docker" as const,
      },
    },
  },
} satisfies SandboxMap;

const fallbackMapFixture = {
  user1: {
    "deco/other": {
      cluster: {
        sandboxHandle: "h2",
        previewUrl: "http://localhost:2",
        sandboxProviderKind: "cluster" as const,
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
