import { describe, expect, it } from "bun:test";
import type { GithubRepo } from "@decocms/mesh-sdk";
import {
  parseRepoFullName,
  planAgentConnections,
  planRepoReuse,
} from "./report-agent-repo-plan";

const repo = (over: Partial<GithubRepo>): GithubRepo => ({
  url: "https://github.com/acme/store",
  owner: "acme",
  name: "store",
  ...over,
});

describe("parseRepoFullName", () => {
  it("splits owner/name", () => {
    expect(parseRepoFullName("acme/store")).toEqual({
      owner: "acme",
      name: "store",
    });
  });

  it("rejects a missing name", () => {
    expect(parseRepoFullName("acme")).toBeNull();
    expect(parseRepoFullName("acme/")).toBeNull();
  });

  it("rejects a missing owner", () => {
    expect(parseRepoFullName("/store")).toBeNull();
    expect(parseRepoFullName("")).toBeNull();
  });
});

describe("planRepoReuse", () => {
  it("reuses when the same repo has a connectionId", () => {
    expect(
      planRepoReuse({
        existingRepo: repo({ connectionId: "conn_1", installationId: 42 }),
        owner: "acme",
        name: "store",
      }),
    ).toEqual({ connectionId: "conn_1", installationId: 42 });
  });

  it("matches repo case-insensitively (GitHub owner/name are)", () => {
    expect(
      planRepoReuse({
        existingRepo: repo({
          owner: "Acme",
          name: "Store",
          connectionId: "conn_1",
        }),
        owner: "acme",
        name: "store",
      }),
    ).toMatchObject({ connectionId: "conn_1" });
  });

  it("does not reuse a different repo", () => {
    expect(
      planRepoReuse({
        existingRepo: repo({ name: "other", connectionId: "conn_1" }),
        owner: "acme",
        name: "store",
      }),
    ).toBeNull();
  });

  it("does not reuse when no connectionId was stored (public-clone mode)", () => {
    expect(
      planRepoReuse({
        existingRepo: repo({ connectionId: undefined }),
        owner: "acme",
        name: "store",
      }),
    ).toBeNull();
  });

  it("does not reuse when there is no existing repo", () => {
    expect(
      planRepoReuse({ existingRepo: null, owner: "acme", name: "store" }),
    ).toBeNull();
  });
});

describe("planAgentConnections", () => {
  it("appends the repo connection as a credential-only link", () => {
    const { staleConnectionId, mergedConnections } = planAgentConnections({
      existingRepo: null,
      existingConnections: [],
      repoConnectionId: "conn_new",
    });
    expect(staleConnectionId).toBeUndefined();
    expect(mergedConnections).toEqual([
      { connection_id: "conn_new", selected_tools: [] },
    ]);
  });

  it("flags the previous repo's connection as stale on a repo switch", () => {
    const { staleConnectionId, mergedConnections } = planAgentConnections({
      existingRepo: repo({ connectionId: "conn_old" }),
      existingConnections: [{ connection_id: "conn_old", selected_tools: [] }],
      repoConnectionId: "conn_new",
    });
    expect(staleConnectionId).toBe("conn_old");
    // stale is de-aggregated (dropped) before the caller deletes it
    expect(mergedConnections).toEqual([
      { connection_id: "conn_new", selected_tools: [] },
    ]);
  });

  it("has no stale connection when the same connection is reused", () => {
    const { staleConnectionId, mergedConnections } = planAgentConnections({
      existingRepo: repo({ connectionId: "conn_1" }),
      existingConnections: [{ connection_id: "conn_1", selected_tools: [] }],
      repoConnectionId: "conn_1",
    });
    expect(staleConnectionId).toBeUndefined();
    // no duplicate: the existing repo connection is filtered then re-added once
    expect(mergedConnections).toEqual([
      { connection_id: "conn_1", selected_tools: [] },
    ]);
  });

  it("preserves unrelated connections and their selected_tools", () => {
    const other = {
      connection_id: "conn_other",
      selected_tools: ["TOOL_A"],
      selected_resources: null,
    };
    const { mergedConnections } = planAgentConnections({
      existingRepo: repo({ connectionId: "conn_old" }),
      existingConnections: [
        other,
        { connection_id: "conn_old", selected_tools: [] },
      ],
      repoConnectionId: "conn_new",
    });
    expect(mergedConnections).toEqual([
      other,
      { connection_id: "conn_new", selected_tools: [] },
    ]);
  });
});
