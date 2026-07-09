import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import type { CurrentLink } from "@/web/hooks/use-current-link";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
  agentShowsGithubHeaderActions,
  findDevPartner,
  getDevAgentIds,
  getLiveDevAgentMaps,
  hasLocalCliHarness,
} from "./agent-capabilities";

const agent = (id: string, liveAgentId?: string): VirtualMCPEntity =>
  ({
    id,
    connections: [],
    metadata: liveAgentId ? { instructions: null, liveAgentId } : null,
  }) as any;

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

describe("agentHasConnectedGithub", () => {
  it("returns false for null/undefined virtualMcp", () => {
    expect(agentHasConnectedGithub(null)).toBe(false);
    expect(agentHasConnectedGithub(undefined)).toBe(false);
  });

  it("returns false for a Start Website agent (no connectionId)", () => {
    const vm = {
      connections: [],
      metadata: {
        githubRepo: {
          url: "https://github.com/decocms/webapp-template",
          owner: "decocms",
          name: "webapp-template",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(false);
  });

  it("returns false when connectionId is set but the connection is detached", () => {
    const vm = {
      connections: [{ connection_id: "conn_other" }],
      metadata: {
        githubRepo: {
          url: "https://github.com/acme/app",
          owner: "acme",
          name: "app",
          connectionId: "conn_github",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(false);
  });

  it("returns true when connectionId is set and the connection is attached", () => {
    const vm = {
      connections: [{ connection_id: "conn_github" }],
      metadata: {
        githubRepo: {
          url: "https://github.com/acme/app",
          owner: "acme",
          name: "app",
          connectionId: "conn_github",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(true);
  });
});

describe("agentShowsGithubHeaderActions", () => {
  it("returns false for a Start Website agent cloned from a public template", () => {
    expect(
      agentShowsGithubHeaderActions({
        connections: [],
        metadata: {
          instructions: null,
          githubRepo: {
            url: "https://github.com/decocms/webapp-template",
            owner: "decocms",
            name: "webapp-template",
          },
        },
      } as any),
    ).toBe(false);
  });

  it("returns true for an imported repo with an attached GitHub connection", () => {
    expect(
      agentShowsGithubHeaderActions({
        connections: [
          {
            connection_id: "conn_github",
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          instructions: null,
          githubRepo: {
            url: "https://github.com/acme/app",
            owner: "acme",
            name: "app",
            connectionId: "conn_github",
          },
        },
      } as any),
    ).toBe(true);
  });

  it("returns true for a detached imported repo (so the header can offer reconnect)", () => {
    expect(
      agentShowsGithubHeaderActions({
        connections: [{ connection_id: "conn_other" }],
        metadata: {
          instructions: null,
          githubRepo: {
            url: "https://github.com/acme/app",
            owner: "acme",
            name: "app",
            connectionId: "conn_github",
          },
        },
      } as any),
    ).toBe(true);
  });
});

describe("hasLocalCliHarness", () => {
  const link = (overrides: Partial<CurrentLink> = {}): CurrentLink => ({
    online: false,
    capabilities: [],
    ready: true,
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

describe("getDevAgentIds", () => {
  it("returns an empty set for null/undefined/empty agents", () => {
    expect(getDevAgentIds(null).size).toBe(0);
    expect(getDevAgentIds(undefined).size).toBe(0);
    expect(getDevAgentIds([]).size).toBe(0);
  });

  it("only includes agents with a string liveAgentId", () => {
    const agents = [agent("dev-1", "live-1"), agent("plain-1")];
    expect(getDevAgentIds(agents)).toEqual(new Set(["dev-1"]));
  });
});

describe("getLiveDevAgentMaps", () => {
  it("returns empty maps for null/undefined/empty agents", () => {
    const { liveToDev, devToLive } = getLiveDevAgentMaps(null);
    expect(liveToDev.size).toBe(0);
    expect(devToLive.size).toBe(0);
  });

  it("builds both directions from dev agents' liveAgentId", () => {
    const agents = [agent("dev-1", "live-1"), agent("plain-1")];
    const { liveToDev, devToLive } = getLiveDevAgentMaps(agents);
    expect(devToLive.get("dev-1")).toBe("live-1");
    expect(liveToDev.get("live-1")).toBe("dev-1");
    expect(devToLive.has("plain-1")).toBe(false);
  });
});

describe("findDevPartner", () => {
  it("returns null for a null/undefined agent", () => {
    expect(findDevPartner(null, [])).toBeNull();
    expect(findDevPartner(undefined, [])).toBeNull();
  });

  it("returns 'dev' mode when the agent itself has a liveAgentId", () => {
    const dev = agent("dev-1", "live-1");
    expect(findDevPartner(dev, [dev])).toEqual({
      mode: "dev",
      targetId: "live-1",
    });
  });

  it("returns 'live' mode when some dev agent points back at this agent", () => {
    const live = agent("live-1");
    const dev = agent("dev-1", "live-1");
    expect(findDevPartner(live, [dev, live])).toEqual({
      mode: "live",
      targetId: "dev-1",
    });
  });

  it("returns null when the agent has no dev/live pairing", () => {
    const solo = agent("solo-1");
    expect(findDevPartner(solo, [solo])).toBeNull();
  });
});
