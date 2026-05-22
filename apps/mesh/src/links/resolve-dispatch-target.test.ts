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
  test("cloud kind + any harness → local/default", async () => {
    const t = await resolveDispatchTarget(
      { harnessId: "claude-code", sandboxProviderKind: "docker", userId: "u" },
      { linkRegistry: stubRegistry(null) },
    );
    expect(t.kind).toBe("local");
    if (t.kind === "local") expect(t.sandbox).toBe("default");
  });

  test("desktop + decopilot + link online → local/desktop", async () => {
    const t = await resolveDispatchTarget(
      {
        harnessId: "decopilot",
        sandboxProviderKind: "desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(t.kind).toBe("local");
    if (t.kind === "local") expect(t.sandbox).toBe("desktop");
  });

  test("desktop + claude-code + link online → remote-cli", async () => {
    const t = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(t.kind).toBe("remote-cli");
  });

  test("desktop + codex + link online → remote-cli", async () => {
    const t = await resolveDispatchTarget(
      { harnessId: "codex", sandboxProviderKind: "desktop", userId: "u" },
      { linkRegistry: stubRegistry(linkOnline()) },
    );
    expect(t.kind).toBe("remote-cli");
  });

  test("desktop + link offline → error/link_offline", async () => {
    const t = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(null) },
    );
    expect(t.kind).toBe("error");
    if (t.kind === "error") expect(t.reason).toBe("link_offline");
  });

  test("desktop + link missing capability → error/capability_missing", async () => {
    const t = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "desktop",
        userId: "u",
      },
      { linkRegistry: stubRegistry(linkOnline(["decopilot-sandbox"])) },
    );
    expect(t.kind).toBe("error");
    if (t.kind === "error") {
      expect(t.reason).toBe("capability_missing");
      expect(t.activeCapabilities).toEqual(["decopilot-sandbox"]);
    }
  });
});
