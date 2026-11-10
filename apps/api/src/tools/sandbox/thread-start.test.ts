import { describe, expect, it } from "bun:test";
import type { RepoChoice } from "../../git-providers/repo-choices";
import { findRepoChoice } from "./thread-start";

const choice = (id: string, owner: string, name: string): RepoChoice => ({
  id,
  owner,
  name,
  label: `${owner}/${name}`,
  webUrl: `https://github.com/${owner}/${name}`,
  provider: "github",
  repository: null,
  connectionId: id,
  installationId: 1,
});

describe("findRepoChoice", () => {
  const site = choice("conn_1", "Acme", "Site");
  const api = choice("conn_2", "acme", "api");

  it("matches an id, then owner/name in any case", () => {
    expect(findRepoChoice([site, api], "conn_2")).toBe(api);
    expect(findRepoChoice([site, api], "acme/site")).toBe(site);
  });

  it("names the linked repositories when nothing matches", () => {
    expect(() => findRepoChoice([site, api], "acme/web")).toThrow(
      'No repository "acme/web" is linked to this organization. Linked: Acme/Site (id: conn_1), acme/api (id: conn_2).',
    );
    expect(() => findRepoChoice([], "acme/web")).toThrow("Linked: none.");
  });

  it("asks for an id when owner/name is ambiguous", () => {
    const gitlab = {
      ...choice("repo_1", "acme", "site"),
      provider: "gitlab" as const,
    };
    expect(() => findRepoChoice([site, gitlab], "acme/site")).toThrow(
      "names several repositories; pass one id: Acme/Site (id: conn_1), acme/site (id: repo_1).",
    );
  });
});
