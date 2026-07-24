import { describe, expect, it } from "bun:test";
import { parseGithubOwnerRepo } from "./parse-github-clone-url";

describe("parseGithubOwnerRepo", () => {
  it("parses a credentialed clone URL", () => {
    expect(
      parseGithubOwnerRepo(
        "https://x-access-token:ghs_abc@github.com/deco-sites/casaevideo-tanstack.git",
      ),
    ).toEqual({ owner: "deco-sites", name: "casaevideo-tanstack" });
  });

  it("parses an anonymous clone URL without .git", () => {
    expect(parseGithubOwnerRepo("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("returns null when owner or name is missing", () => {
    expect(parseGithubOwnerRepo("https://github.com/owner")).toBeNull();
    expect(parseGithubOwnerRepo("https://github.com/")).toBeNull();
  });

  it("returns null for a non-URL string", () => {
    expect(parseGithubOwnerRepo("git@github.com:owner/repo.git")).toBeNull();
  });
});
