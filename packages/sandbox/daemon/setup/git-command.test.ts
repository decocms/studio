import { describe, expect, test } from "bun:test";
import { gitBaseArgv, gitStepEnv } from "./git-command";

describe("gitBaseArgv", () => {
  test("carries exactly today's hardening flags, unquoted", () => {
    expect(gitBaseArgv()).toEqual([
      "git",
      "-c",
      "safe.directory=*",
      "-c",
      "credential.helper=",
      "-c",
      "http.connectTimeout=10",
      "-c",
      "http.lowSpeedLimit=1",
      "-c",
      "http.lowSpeedTime=10",
    ]);
  });

  test("returns a fresh array each call (callers push onto it)", () => {
    const a = gitBaseArgv();
    a.push("clone");
    expect(gitBaseArgv()).not.toContain("clone");
  });
});

describe("gitStepEnv", () => {
  test("refuses prompts and points GIT_ASKPASS at the noop", () => {
    expect(gitStepEnv("/data/askpass.sh")).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/data/askpass.sh",
    });
  });
});
