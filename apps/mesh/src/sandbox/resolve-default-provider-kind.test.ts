import { describe, expect, test } from "bun:test";
import { resolveDefaultSandboxProviderKind } from "./resolve-default-provider-kind";
import type { LinkClaimRegistry } from "@/links/link-claim-registry";
import type { LinkClaim } from "../links/link-claim-registry";

const linkOnline = (
  caps: string[] = ["claude-code", "codex", "decopilot-sandbox"],
): LinkClaim =>
  ({
    podId: "pod_1",
    machineId: "m1",
    cliVersion: "1.0.0",
    previewPort: 5174,
    connectedAt: Date.now(),
    capabilities: caps,
  }) as LinkClaim;

function stubRegistry(link: LinkClaim | null): LinkClaimRegistry {
  return { get: async () => link } as unknown as LinkClaimRegistry;
}

describe("resolveDefaultSandboxProviderKind", () => {
  test("returns user-desktop when the user's link is online", async () => {
    const kind = await resolveDefaultSandboxProviderKind("u-1", {
      linkClaimRegistry: stubRegistry(linkOnline()),
      resolveEnvKind: () => "cluster",
    });
    expect(kind).toBe("user-desktop");
  });

  test("falls back to env kind when no link is registered", async () => {
    const kind = await resolveDefaultSandboxProviderKind("u-1", {
      linkClaimRegistry: stubRegistry(null),
      resolveEnvKind: () => "cluster",
    });
    expect(kind).toBe("cluster");
  });
});
