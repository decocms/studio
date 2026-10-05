import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { isStudioCliCommand, runStudioCli, STUDIO_CLI_COMMANDS } from "./index";

let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  out = [];
  err = [];
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    out.push(String(msg));
  });
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    err.push(String(msg));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("runStudioCli", () => {
  it("claims exactly its own commands", () => {
    for (const command of STUDIO_CLI_COMMANDS) {
      expect(isStudioCliCommand(command)).toBe(true);
    }
    for (const command of ["dev", "init", undefined, ""]) {
      expect(isStudioCliCommand(command)).toBe(false);
    }
  });

  it("prints usage for --help", async () => {
    expect(await runStudioCli(["tools", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("decocms tools <list|describe|call>");
  });

  it("reports an unknown flag instead of throwing", async () => {
    expect(await runStudioCli(["tools", "list", "--nope"])).toBe(1);
    expect(err.join("\n")).toContain("--nope");
  });

  it("prints usage for an unknown auth subcommand", async () => {
    expect(await runStudioCli(["auth", "nope"])).toBe(1);
    expect(err.join("\n")).toContain(
      "decocms auth <login|whoami|token|logout>",
    );
  });
});
