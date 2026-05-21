import { describe, expect, it } from "bun:test";
import type { CurrentLink } from "@/web/hooks/use-current-link";
import {
  agentHasClonableSource,
  hasLocalCliHarness,
} from "./agent-capabilities";

describe("agentHasClonableSource", () => {
  it("returns false for null/undefined metadata", () => {
    expect(agentHasClonableSource(null)).toBe(false);
    expect(agentHasClonableSource(undefined)).toBe(false);
  });

  it("returns false for metadata without githubRepo", () => {
    expect(agentHasClonableSource({})).toBe(false);
    expect(agentHasClonableSource({ githubRepo: null })).toBe(false);
  });

  it("returns false when githubRepo.url is absent or empty", () => {
    expect(agentHasClonableSource({ githubRepo: {} })).toBe(false);
    expect(agentHasClonableSource({ githubRepo: { url: "" } })).toBe(false);
  });

  it("returns true for a Start Website agent (no connectionId)", () => {
    expect(
      agentHasClonableSource({
        githubRepo: {
          url: "https://github.com/decocms/webapp-template",
          owner: "decocms",
          name: "webapp-template",
        },
      }),
    ).toBe(true);
  });

  it("returns true for a github-imported agent (with connectionId)", () => {
    expect(
      agentHasClonableSource({
        githubRepo: {
          url: "https://github.com/acme/app",
          owner: "acme",
          name: "app",
          connectionId: "conn_abc123",
          installationId: 42,
        },
      }),
    ).toBe(true);
  });

  it("ignores non-object metadata", () => {
    expect(agentHasClonableSource("string")).toBe(false);
    expect(agentHasClonableSource(42)).toBe(false);
  });
});

describe("hasLocalCliHarness", () => {
  const link = (overrides: Partial<CurrentLink> = {}): CurrentLink => ({
    online: false,
    capabilities: [],
    ...overrides,
  });

  it("returns false when the link is offline", () => {
    expect(hasLocalCliHarness(link({ online: false }))).toBe(false);
    expect(
      hasLocalCliHarness(
        link({ online: false, capabilities: ["claude-code"] }),
      ),
    ).toBe(false);
  });

  it("returns false when online but no CLI harness is reported", () => {
    expect(hasLocalCliHarness(link({ online: true }))).toBe(false);
    expect(
      hasLocalCliHarness(
        link({ online: true, capabilities: ["decopilot-sandbox"] }),
      ),
    ).toBe(false);
  });

  it("returns true when online with claude-code or codex", () => {
    expect(
      hasLocalCliHarness(link({ online: true, capabilities: ["claude-code"] })),
    ).toBe(true);
    expect(
      hasLocalCliHarness(link({ online: true, capabilities: ["codex"] })),
    ).toBe(true);
    expect(
      hasLocalCliHarness(
        link({ online: true, capabilities: ["claude-code", "codex"] }),
      ),
    ).toBe(true);
  });
});
