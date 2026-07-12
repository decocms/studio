import { describe, expect, it } from "bun:test";
import type { CurrentLink } from "@/web/hooks/use-current-link";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
  agentShowsGithubHeaderActions,
  defaultAgentOption,
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

describe("defaultAgentOption", () => {
  const link = (overrides: Partial<CurrentLink> = {}): CurrentLink => ({
    online: false,
    capabilities: [],
    ready: true,
    ...overrides,
  });

  it("returns null when cloud provider keys exist (SaaS default → cloud)", () => {
    expect(
      defaultAgentOption(
        true,
        link({ online: true, capabilities: ["claude-code"] }),
      ),
    ).toBeNull();
  });

  it("returns null with no keys when the link is offline", () => {
    expect(
      defaultAgentOption(
        false,
        link({ online: false, capabilities: ["claude-code"] }),
      ),
    ).toBeNull();
  });

  it("returns null with no keys when online but no CLI harness is reported", () => {
    expect(defaultAgentOption(false, link({ online: true }))).toBeNull();
    expect(
      defaultAgentOption(
        false,
        link({ online: true, capabilities: ["decopilot-sandbox"] }),
      ),
    ).toBeNull();
  });

  it("falls back to a local CLI (Claude Code first) with no keys", () => {
    expect(
      defaultAgentOption(
        false,
        link({ online: true, capabilities: ["claude-code"] }),
      ),
    ).toBe("claude-code-desktop");
    expect(
      defaultAgentOption(
        false,
        link({ online: true, capabilities: ["codex"] }),
      ),
    ).toBe("codex-desktop");
    expect(
      defaultAgentOption(
        false,
        link({ online: true, capabilities: ["codex", "claude-code"] }),
      ),
    ).toBe("claude-code-desktop");
  });
});
