import { describe, expect, test } from "bun:test";
import { resolveDefaultSandboxProviderKind } from "./resolve-default-provider-kind";
import type { LinkRegistry } from "@/links/link-registry";
import type { LinkEntry } from "../links/protocol";

const linkOnline = (
  caps: string[] = ["claude-code", "codex", "decopilot-sandbox"],
): LinkEntry =>
  ({
    tunnelUrl: "https://t.example",
    linkSecret: "s",
    capabilities: caps,
  }) as LinkEntry;

function stubRegistry(link: LinkEntry | null): LinkRegistry {
  return { get: async () => link } as unknown as LinkRegistry;
}

describe("resolveDefaultSandboxProviderKind", () => {
  test("returns user-desktop when the user's link is online", async () => {
    const kind = await resolveDefaultSandboxProviderKind("u-1", {
      linkRegistry: stubRegistry(linkOnline()),
      resolveEnvKind: () => "local-docker",
    });
    expect(kind).toBe("user-desktop");
  });

  test("falls back to env kind when no link is registered", async () => {
    const kind = await resolveDefaultSandboxProviderKind("u-1", {
      linkRegistry: stubRegistry(null),
      resolveEnvKind: () => "local-docker",
    });
    expect(kind).toBe("local-docker");
  });
});
