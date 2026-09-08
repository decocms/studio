/**
 * The import payload is a wire contract with `COLLECTION_VIRTUAL_MCP_CREATE`,
 * and this file got it wrong once in a way nothing caught: `connections` is
 * required by the tool's schema, so omitting it made every import fail with a
 * 400 while the picker closed as though it had worked — no project, no error.
 */
import { describe, expect, it } from "bun:test";
import { agentPayload } from "./repository-picker-bridge";

const repo = {
  name: "storefront",
  owner: "group/team",
  url: "https://gitlab.com/group/team/storefront",
};

describe("agentPayload", () => {
  /** The regression: present and empty, not absent. */
  it("always carries connections, even with none to attach", () => {
    const payload = agentPayload({ id: "rep_1" }, repo, { description: "d" });
    expect(payload.connections).toEqual([]);
    expect(Object.hasOwn(payload, "connections")).toBe(true);
  });

  /** What every provider client resolves the credential from. */
  it("records the repository id on the binding", () => {
    expect(
      agentPayload({ id: "rep_1" }, repo, { description: "d" }).metadata
        .githubRepo.repositoryId,
    ).toBe("rep_1");
  });

  /**
   * A GitLab project in subgroups keeps every namespace level in `owner`, and
   * the URL is what names the provider — neither may be flattened away.
   */
  it("keeps a nested namespace and the provider-bearing URL", () => {
    const { githubRepo } = agentPayload({ id: "rep_1" }, repo, {
      description: "d",
    }).metadata;
    expect(githubRepo.owner).toBe("group/team");
    expect(githubRepo.name).toBe("storefront");
    expect(githubRepo.url).toBe("https://gitlab.com/group/team/storefront");
  });

  /** Both providers open on the editor; the provider-gated default is gone. */
  it("opens on the site editor regardless of provider", () => {
    expect(
      agentPayload({ id: "rep_1" }, repo, { description: "d" }).metadata.ui
        .layout.defaultMainView.type,
    ).toBe("site-editor");
  });
});
