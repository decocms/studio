import { describe, expect, test } from "bun:test";
import {
  DECO_SITES_GITHUB_OWNER,
  parseDecoSiteGithubFromMetadata,
  resolveDecoSiteGithubRepo,
} from "./deco-sites-github";

describe("parseDecoSiteGithubFromMetadata", () => {
  test("returns owner and repo when metadata.github is set", () => {
    expect(
      parseDecoSiteGithubFromMetadata({
        github: { owner: "stone-payments", repo: "ton-site-deco" },
      }),
    ).toEqual({ owner: "stone-payments", repo: "ton-site-deco" });
  });

  test("returns null when github block is missing", () => {
    expect(parseDecoSiteGithubFromMetadata({})).toBeNull();
    expect(parseDecoSiteGithubFromMetadata(null)).toBeNull();
  });
});

describe("resolveDecoSiteGithubRepo", () => {
  test("falls back to deco-sites org and site name", () => {
    expect(resolveDecoSiteGithubRepo("acme")).toEqual({
      owner: DECO_SITES_GITHUB_OWNER,
      name: "acme",
      url: "https://github.com/deco-sites/acme",
    });
  });

  test("uses metadata.github when present", () => {
    expect(
      resolveDecoSiteGithubRepo("ton", {
        github: { owner: "stone-payments", repo: "ton-site-deco" },
      }),
    ).toEqual({
      owner: "stone-payments",
      name: "ton-site-deco",
      url: "https://github.com/stone-payments/ton-site-deco",
    });
  });

  test("falls back when metadata.github is malformed", () => {
    expect(
      resolveDecoSiteGithubRepo("acme", { github: { owner: "" } }),
    ).toEqual({
      owner: DECO_SITES_GITHUB_OWNER,
      name: "acme",
      url: "https://github.com/deco-sites/acme",
    });
  });
});
