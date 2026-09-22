import { describe, expect, test } from "bun:test";
import { githubReauthUrl } from "./github-reauth-url";

const repositories = [
  { path: "decocms/studio", accountId: "acc_1" },
  { path: "solo-dev", accountId: "acc_2" },
  { path: "decocms/apps", accountId: null },
];
const call = (repo: string | null) =>
  githubReauthUrl({
    orgSlug: "deco-studio",
    repo,
    repositories,
    returnTo: "/deco-studio/tasks/DECO-214",
  });

describe("githubReauthUrl", () => {
  test("reconfigures the installation behind the card's repo", () => {
    expect(call("decocms/studio")).toEqual({
      url: "/api/deco-studio/git-providers/github/accounts/acc_1/manage",
      ownerOnly: true,
      owner: "decocms",
    });
  });

  test("a user-account repo has no organization owner to route around", () => {
    expect(call("solo-dev")).toEqual({
      url: "/api/deco-studio/git-providers/github/accounts/acc_2/manage",
      ownerOnly: false,
      owner: null,
    });
  });

  test("falls back to installing the App when no account holds the repo", () => {
    const install = {
      url: "/api/deco-studio/git-providers/github/install?returnTo=%2Fdeco-studio%2Ftasks%2FDECO-214",
      ownerOnly: false,
      owner: null,
    };
    expect(call("decocms/apps")).toEqual(install);
    expect(call("someone/else")).toEqual(install);
    expect(call(null)).toEqual(install);
  });
});
