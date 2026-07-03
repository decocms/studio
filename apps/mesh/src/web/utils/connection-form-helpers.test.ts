import { describe, expect, it } from "bun:test";
import {
  buildCustomStdioParameters,
  parseNpxLikeCommand,
} from "./connection-form-helpers";

describe("parseNpxLikeCommand", () => {
  it("extracts the package name from a plain npx/bunx command", () => {
    expect(parseNpxLikeCommand("npx some-package")).toEqual({
      packageName: "some-package",
    });
    expect(parseNpxLikeCommand("bunx some-package")).toEqual({
      packageName: "some-package",
    });
  });

  it("skips leading flags to find the package name", () => {
    expect(parseNpxLikeCommand("npx -y some-package")).toEqual({
      packageName: "some-package",
    });
    expect(parseNpxLikeCommand("npx --yes --silent some-package")).toEqual({
      packageName: "some-package",
    });
  });

  it("is case-insensitive on the command but not the package name", () => {
    expect(parseNpxLikeCommand("NPX some-package")).toEqual({
      packageName: "some-package",
    });
  });

  it("returns null when the command isn't npx/bunx", () => {
    expect(parseNpxLikeCommand("node some-package")).toBeNull();
  });

  it("returns null when there's no package name (only a command)", () => {
    expect(parseNpxLikeCommand("npx")).toBeNull();
  });

  it("returns null when only flags follow the command", () => {
    expect(parseNpxLikeCommand("npx -y --silent")).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(parseNpxLikeCommand("")).toBeNull();
    expect(parseNpxLikeCommand("   ")).toBeNull();
  });
});

describe("buildCustomStdioParameters", () => {
  it("splits the args string on whitespace", () => {
    expect(
      buildCustomStdioParameters("my-cli", "run --watch", undefined, []),
    ).toEqual({ command: "my-cli", args: ["run", "--watch"] });
  });

  it("omits args when the args string is empty or whitespace-only", () => {
    expect(buildCustomStdioParameters("my-cli", "", undefined, [])).toEqual({
      command: "my-cli",
    });
    expect(buildCustomStdioParameters("my-cli", "   ", undefined, [])).toEqual({
      command: "my-cli",
    });
  });

  it("trims and includes cwd only when non-blank", () => {
    expect(buildCustomStdioParameters("my-cli", "", "  /repo  ", [])).toEqual({
      command: "my-cli",
      cwd: "/repo",
    });
    expect(buildCustomStdioParameters("my-cli", "", "   ", [])).toEqual({
      command: "my-cli",
    });
  });

  it("includes envVars only when at least one has a non-blank key", () => {
    const withVars = buildCustomStdioParameters("my-cli", "", undefined, [
      { key: "API_KEY", value: "secret" },
    ]);
    expect(withVars.envVars).toEqual({ API_KEY: "secret" });

    const withoutVars = buildCustomStdioParameters("my-cli", "", undefined, [
      { key: "  ", value: "ignored" },
    ]);
    expect(withoutVars.envVars).toBeUndefined();
  });
});
