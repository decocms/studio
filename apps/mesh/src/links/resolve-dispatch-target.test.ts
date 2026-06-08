import { describe, expect, test } from "bun:test";
import type { LegacySandboxProviderKind } from "@decocms/sandbox/provider";
import {
  createInMemoryLinkClaimRegistry,
  type LinkClaim,
} from "./link-claim-registry";
import { resolveDispatchTarget } from "./resolve-dispatch-target";

function makeClaim(overrides: Partial<LinkClaim> = {}): LinkClaim {
  return {
    podId: "pod-1",
    machineId: "machine-1",
    hostname: "laptop",
    cliVersion: "1.0.0",
    previewPort: 4317,
    connectedAt: 1,
    capabilities: [],
    ...overrides,
  };
}

describe("resolveDispatchTarget", () => {
  test("agent-sandbox resolves to hosted execution", async () => {
    const linkClaimRegistry = createInMemoryLinkClaimRegistry();

    await expect(
      resolveDispatchTarget(
        {
          harnessId: "codex",
          sandboxProviderKind: "agent-sandbox",
          userId: "user-1",
        },
        { linkClaimRegistry },
      ),
    ).resolves.toEqual({
      ok: true,
      target: { sandboxProviderKind: "agent-sandbox" },
    });
  });

  test("legacy cluster input normalizes to agent-sandbox", async () => {
    const linkClaimRegistry = createInMemoryLinkClaimRegistry();

    await expect(
      resolveDispatchTarget(
        {
          harnessId: "codex",
          sandboxProviderKind: "cluster" as LegacySandboxProviderKind,
          userId: "user-1",
        },
        { linkClaimRegistry },
      ),
    ).resolves.toEqual({
      ok: true,
      target: { sandboxProviderKind: "agent-sandbox" },
    });
  });

  test("user-desktop decopilot resolves to the desktop link when capability is present", async () => {
    const linkClaimRegistry = createInMemoryLinkClaimRegistry();
    const link = makeClaim({ capabilities: ["decopilot-sandbox"] });
    await linkClaimRegistry.put("user-1", link);

    await expect(
      resolveDispatchTarget(
        {
          harnessId: "decopilot",
          sandboxProviderKind: "user-desktop",
          userId: "user-1",
        },
        { linkClaimRegistry },
      ),
    ).resolves.toEqual({
      ok: true,
      target: { sandboxProviderKind: "user-desktop", link },
    });
  });

  test("user-desktop returns offline when no link is registered", async () => {
    const linkClaimRegistry = createInMemoryLinkClaimRegistry();

    await expect(
      resolveDispatchTarget(
        {
          harnessId: "codex",
          sandboxProviderKind: "user-desktop",
          userId: "user-1",
        },
        { linkClaimRegistry },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "user_desktop_link_offline" },
    });
  });

  test("user-desktop returns missing capability when the harness capability is absent", async () => {
    const linkClaimRegistry = createInMemoryLinkClaimRegistry();
    await linkClaimRegistry.put(
      "user-1",
      makeClaim({ capabilities: ["claude-code"] }),
    );

    await expect(
      resolveDispatchTarget(
        {
          harnessId: "codex",
          sandboxProviderKind: "user-desktop",
          userId: "user-1",
        },
        { linkClaimRegistry },
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "user_desktop_link_capability_missing",
        activeCapabilities: ["claude-code"],
      },
    });
  });
});
