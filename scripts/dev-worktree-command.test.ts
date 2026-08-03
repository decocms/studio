import { describe, expect, test } from "bun:test";
import { buildDevCommand } from "./dev-worktree-command";

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
