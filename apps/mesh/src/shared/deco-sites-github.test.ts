import { describe, expect, test } from "bun:test";
import {
  DECO_SITES_GITHUB_OWNER,
  decoSiteGithubRepo,
} from "./deco-sites-github";

describe("decoSiteGithubRepo", () => {
  test("maps site name to deco-sites org repo", () => {
    expect(decoSiteGithubRepo("acme")).toEqual({
      owner: DECO_SITES_GITHUB_OWNER,
      name: "acme",
      url: "https://github.com/deco-sites/acme",
    });
  });
});
