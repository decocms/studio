import { describe, expect, test } from "bun:test";
import { findGithubInstallation } from "./github-installations";

describe("findGithubInstallation", () => {
  const installations = [
    {
      installationId: 1,
      login: "deco-sites",
      avatarUrl: "",
      type: "Organization",
    },
    {
      installationId: 2,
      login: "Acme",
      avatarUrl: "",
      type: "Organization",
    },
  ];

  test("matches login case-insensitively", () => {
    expect(findGithubInstallation(installations, "DECO-SITES")).toEqual(
      installations[0],
    );
  });

  test("returns undefined when login is absent", () => {
    expect(findGithubInstallation(installations, "missing")).toBeUndefined();
  });

  test("returns undefined for an empty list", () => {
    expect(findGithubInstallation([], "deco-sites")).toBeUndefined();
  });
});
