import { describe, expect, it } from "bun:test";
import {
  agentCanBePinned,
  agentHasClonableSource,
  agentHasConnectedGithub,
  agentIsSidebarPinned,
  agentShowsGithubHeaderActions,
} from "./agent-capabilities";

const CODE_META = {
  githubRepo: {
    url: "https://github.com/acme/app",
    owner: "acme",
    name: "app",
  },
};

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

describe("agentCanBePinned", () => {
  it("returns true for a non-code agent (no clonable source)", () => {
    expect(agentCanBePinned({ metadata: {} })).toBe(true);
    expect(agentCanBePinned({ metadata: null })).toBe(true);
  });

  it("returns false for a code agent (clonable source)", () => {
    expect(agentCanBePinned({ metadata: CODE_META })).toBe(false);
  });
});

describe("agentIsSidebarPinned", () => {
  it("returns true only when a non-code agent is pinned", () => {
    expect(agentIsSidebarPinned({ pinned: true, metadata: {} })).toBe(true);
  });

  it("returns false when not pinned", () => {
    expect(agentIsSidebarPinned({ pinned: false, metadata: {} })).toBe(false);
    expect(agentIsSidebarPinned({ pinned: undefined, metadata: {} })).toBe(
      false,
    );
  });

  it("returns false for a pinned code agent (already auto-listed)", () => {
    expect(agentIsSidebarPinned({ pinned: true, metadata: CODE_META })).toBe(
      false,
    );
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
