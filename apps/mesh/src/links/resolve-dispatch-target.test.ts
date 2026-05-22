import { describe, expect, test } from "bun:test";
import { resolveDispatchTarget } from "./resolve-dispatch-target";
import type { LinkRegistry } from "./link-registry";
import type { LinkEntry } from "./protocol";

const linkOnline = (
  caps: string[] = ["claude-code", "codex", "decopilot-sandbox"],
): LinkEntry =>
  ({
    tunnelUrl: "https://t.example",
    linkSecret: "s",
    capabilities: caps,
  }) as LinkEntry;

const stubRegistry = (link: LinkEntry | null): LinkRegistry =>
  ({ get: async () => link }) as unknown as LinkRegistry;

describe("resolveDispatchTarget", () => {
  test("cloud kind + any harness → cluster runsIn with cluster sandbox", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "local-docker",
        userId: "u",
      },
      { linkRegistry: stubRegistry(null) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.target.runsIn).toBe("cluster");
    expect(result.target.sandbox).toBe("local-docker");
  });

  test("user-desktop + decopilot + link online → cluster runsIn with user-desktop sandbox", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "decopilot",
        sandboxProviderKind: "user-desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.target.runsIn).toBe("cluster");
    expect(result.target.sandbox).toBe("user-desktop");
  });

  test("user-desktop + claude-code + link online → user-desktop runsIn", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.target.runsIn).toBe("user-desktop");
    expect(result.target.sandbox).toBe("user-desktop");
  });

  test("user-desktop + codex + link online → user-desktop runsIn", async () => {
    const result = await resolveDispatchTarget(
      { harnessId: "codex", sandboxProviderKind: "user-desktop", userId: "u" },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.target.runsIn).toBe("user-desktop");
  });

  test("returns user_desktop_link_offline when no link", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(null) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("user_desktop_link_offline");
  });

  test("returns user_desktop_link_capability_missing when link lacks capability", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline(["decopilot-sandbox"])) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("user_desktop_link_capability_missing");
    if (result.error.kind === "user_desktop_link_capability_missing") {
      expect(result.error.activeCapabilities).toEqual(["decopilot-sandbox"]);
    }
  });
});
