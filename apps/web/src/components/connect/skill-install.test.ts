import { describe, expect, test } from "bun:test";
import { cliLoginCommand, skillInstallCommand } from "./skill-install";

describe("skillInstallCommand", () => {
  test("installs the plugin from the marketplace in Claude Code", () => {
    expect(skillInstallCommand("claude-code")).toBe(
      "claude plugin marketplace add decocms/studio\nclaude plugin install decocms-studio@decocms",
    );
  });

  test("targets the picked agent through the skills CLI", () => {
    expect(skillInstallCommand("cursor")).toEndWith(" -g -a cursor");
    expect(skillInstallCommand("codex")).toEndWith(" -g -a codex");
  });

  test("lets the skills CLI ask for any other agent", () => {
    expect(skillInstallCommand("raw")).toBe(
      "npx skills add decocms/studio --skill decocms-studio -g",
    );
  });
});

describe("cliLoginCommand", () => {
  test("omits --target on the CLI's default studio", () => {
    expect(cliLoginCommand("https://studio.decocms.com")).toBe(
      "bunx decocms@latest auth login",
    );
  });

  test("points a self-hosted or local studio at its own origin", () => {
    expect(cliLoginCommand("http://localhost:3000")).toBe(
      "bunx decocms@latest auth login --target http://localhost:3000",
    );
  });
});
