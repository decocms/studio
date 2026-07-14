import { describe, expect, test } from "bun:test";
import { askpassSpec } from "./askpass";

describe("askpassSpec", () => {
  test("win32 gets a .bat that exits 0", () => {
    expect(askpassSpec("win32")).toEqual({
      filename: "askpass.bat",
      content: "@exit /b 0\r\n",
    });
  });

  test("posix gets an executable sh noop", () => {
    expect(askpassSpec("darwin")).toEqual({
      filename: "askpass.sh",
      content: "#!/bin/sh\nexit 0\n",
    });
    expect(askpassSpec("linux").filename).toBe("askpass.sh");
  });
});
