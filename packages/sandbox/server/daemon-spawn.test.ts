import { describe, expect, it } from "bun:test";
import { resolveDaemonStdio } from "./daemon-spawn";

describe("resolveDaemonStdio", () => {
  it("inherits the parent fds when no log fd is given", () => {
    expect(resolveDaemonStdio()).toBe("inherit");
    expect(resolveDaemonStdio(undefined)).toBe("inherit");
  });

  it("returns the provided fd so the child writes to the log file", () => {
    expect(resolveDaemonStdio(7)).toBe(7);
  });
});
