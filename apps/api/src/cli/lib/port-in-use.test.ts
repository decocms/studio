import { describe, expect, it } from "bun:test";
import {
  formatPortInUseMessage,
  isAddressInUseError,
  PortInUseError,
  portTerminationCommand,
} from "./port-in-use";

describe("portTerminationCommand", () => {
  it("returns the cmd command on Windows", () => {
    expect(portTerminationCommand(5174, "win32")).toBe(
      'for /f "tokens=5" %P in (\'netstat -ano ^| findstr /R /C:":5174 .*LISTENING"\') do taskkill /F /PID %P',
    );
  });

  it("returns the POSIX command on Linux and macOS", () => {
    const command = "kill -9 $(lsof -ti tcp:5174)";
    expect(portTerminationCommand(5174, "linux")).toBe(command);
    expect(portTerminationCommand(5174, "darwin")).toBe(command);
  });
});

describe("formatPortInUseMessage", () => {
  it("renders only the command for the current platform", () => {
    const windowsMessage = formatPortInUseMessage(5174, "win32");
    expect(windowsMessage).toContain("netstat -ano");
    expect(windowsMessage).toContain("taskkill /F /PID %P");
    expect(windowsMessage).not.toContain("lsof");

    const posixMessage = formatPortInUseMessage(5174, "darwin");
    expect(posixMessage).toContain("lsof -ti tcp:5174");
    expect(posixMessage).not.toContain("netstat -ano");
  });
});

describe("isAddressInUseError", () => {
  it("recognizes preflight and Bun listen errors", () => {
    expect(isAddressInUseError(new PortInUseError(5174))).toBe(true);
    expect(isAddressInUseError({ code: "EADDRINUSE" })).toBe(true);
    expect(isAddressInUseError(new Error("unrelated"))).toBe(false);
  });
});
