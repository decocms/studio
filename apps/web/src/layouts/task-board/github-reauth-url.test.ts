import { describe, expect, test } from "bun:test";
import { githubReauthUrl } from "./github-reauth-url";

const repositories = [
  { path: "decocms/studio", accountId: "acc_1" },
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
    expect(call("decocms/studio")).toBe(
      "/api/deco-studio/git-providers/github/accounts/acc_1/manage",
    );
  });

  test("falls back to installing the App when no account holds the repo", () => {
    const install =
      "/api/deco-studio/git-providers/github/install?returnTo=%2Fdeco-studio%2Ftasks%2FDECO-214";
    expect(call("decocms/apps")).toBe(install);
    expect(call("someone/else")).toBe(install);
    expect(call(null)).toBe(install);
  });
});
