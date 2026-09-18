import { describe, expect, test } from "bun:test";
import { changeRequestLabel, checkoutCommandFor, providerCli } from "./cli";

describe("providerCli", () => {
  test("each provider names its own CLI, or none", () => {
    expect(providerCli("github").cli).toBe("gh");
    expect(providerCli("gitlab").cli).toBe("glab");
    // Bitbucket ships no CLI; the create command is the REST API over curl.
    expect(providerCli("bitbucket").cli).toBeNull();
    expect(providerCli("bitbucket").createCommand).toContain(
      "api.bitbucket.org/2.0/repositories",
    );
    expect(providerCli("bitbucket").createCommand).toContain("BITBUCKET_TOKEN");
  });
});

describe("checkoutCommandFor", () => {
  test("fills the number in where the CLI takes one", () => {
    expect(checkoutCommandFor("github", 7)).toBe("gh pr checkout 7");
    expect(checkoutCommandFor("gitlab", 7)).toBe("glab mr checkout 7");
  });
  test("names the source branch where no CLI can address a number", () => {
    const command = checkoutCommandFor("bitbucket", 7);
    expect(command).toContain("git checkout <source branch>");
    expect(command).not.toContain("7");
  });
});

describe("changeRequestLabel", () => {
  test("writes the number the way each provider does", () => {
    expect(changeRequestLabel("github", 7)).toBe("PR #7");
    expect(changeRequestLabel("gitlab", 7)).toBe("MR !7");
    expect(changeRequestLabel("bitbucket", 7)).toBe("PR #7");
  });
});
