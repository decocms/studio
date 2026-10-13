import { describe, expect, test } from "bun:test";
import { cliLoginCommand } from "./skill-install";

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
