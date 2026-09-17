import { describe, expect, it } from "bun:test";
import { pullRequestFromLinks } from "./pr-link";

const pr = (n: number) => ({
  url: `https://github.com/acme/web/pull/${n}`,
});
const preview = { url: "https://envs-acme--ab12cd.decocdn.com/collection/men" };

describe("pullRequestFromLinks", () => {
  it("finds the pull request among the issue's other links", () => {
    expect(pullRequestFromLinks([preview, pr(12)])?.number).toBe(12);
    expect(pullRequestFromLinks([pr(12), preview])?.repo.path).toBe("acme/web");
  });

  // A card routinely carries more than one: a pull request from a superseded
  // run, or one a person added from elsewhere. Jira returns them oldest-first,
  // so the one the latest run opened is the last.
  it("takes the newest when the issue names several", () => {
    expect(pullRequestFromLinks([pr(337), pr(338)])?.number).toBe(338);
    expect(pullRequestFromLinks([pr(337), preview, pr(373)])?.number).toBe(373);
  });

  it("is null when the issue names no pull request", () => {
    expect(pullRequestFromLinks([])).toBeNull();
    expect(pullRequestFromLinks([preview])).toBeNull();
    expect(pullRequestFromLinks([{ url: "not a url" }])).toBeNull();
  });
});
