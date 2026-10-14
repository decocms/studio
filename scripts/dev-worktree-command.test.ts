import { describe, expect, test } from "bun:test";
import { buildDevCommand, worktreeHostSlug } from "./dev-worktree-command";

describe("worktreeHostSlug", () => {
  test("turns a workspace display name into a hostname label", () => {
    expect(worktreeHostSlug("Publish modal decofile diff")).toBe(
      "publish-modal-decofile-diff",
    );
  });

  test("keeps an already valid slug", () => {
    expect(worktreeHostSlug("delhi-v4")).toBe("delhi-v4");
  });

  test("drops punctuation and edge dashes", () => {
    expect(worktreeHostSlug("  Fix: login/SSO (v2)! ")).toBe(
      "fix-login-sso-v2",
    );
  });

  test("caps the label at 63 characters without a trailing dash", () => {
    const slug = worktreeHostSlug(`${"a".repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("empty when nothing usable remains", () => {
    expect(worktreeHostSlug(" !! ")).toBe("");
    expect(worktreeHostSlug("")).toBe("");
  });
});

describe("buildDevCommand", () => {
  test("defaults dev home outside the repo for worktree runs", () => {
    const command = buildDevCommand({
      repoRoot: "/repo",
      slug: "delhi-v4",
      port: 3001,
      vitePort: 4000,
      extraArgs: ["--no-tui"],
      tmpRoot: "/tmp",
    });

    expect(command).toContain("--home");
    expect(command).toContain("/tmp/decocms-dev-delhi-v4");
  });

  test("preserves an explicit home argument", () => {
    const command = buildDevCommand({
      repoRoot: "/repo",
      slug: "delhi-v4",
      port: 3001,
      vitePort: 4000,
      extraArgs: ["--home", "/custom/home", "--no-tui"],
      tmpRoot: "/tmp",
    });

    const homeIndexes = command
      .map((arg, index) => (arg === "--home" ? index : -1))
      .filter((index) => index !== -1);

    expect(homeIndexes).toEqual([command.indexOf("--home")]);
    expect(command).toContain("/custom/home");
    expect(command).not.toContain("/tmp/decocms-dev-delhi-v4");
  });
});
