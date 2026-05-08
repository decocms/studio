import { describe, expect, it } from "bun:test";
import { spawnPty } from "./pty-spawn";

// forkpty(3) is unavailable in GitHub Actions containers.
describe.skipIf(!!process.env.CI)("spawnPty", () => {
  it("runs a command in a PTY and streams its output", async () => {
    const child = spawnPty({ cmd: "echo hello-pty" });
    const chunks: string[] = [];
    child.onData((data) => chunks.push(data));

    const exitCode = await new Promise<number>((resolve) => {
      child.onExit((code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("hello-pty");
  });

  it("propagates env and detects the PTY (TERM is xterm-256color)", async () => {
    const child = spawnPty({ cmd: 'echo "TERM=$TERM"' });
    const chunks: string[] = [];
    child.onData((data) => chunks.push(data));

    await new Promise<number>((resolve) => {
      child.onExit((code) => resolve(code));
    });

    expect(chunks.join("")).toContain("TERM=xterm-256color");
  });

  it("kill() terminates a long-running child", async () => {
    const child = spawnPty({ cmd: "sleep 30" });
    const exitPromise = new Promise<number>((resolve) => {
      child.onExit((code) => resolve(code));
    });
    child.kill();
    const code = await exitPromise;
    // node-pty maps signal kills to shell-convention exit codes (128 + signal).
    // Default kill signal is SIGHUP (signal 1) -> exit code 129.
    // On macOS, node-pty reports exitCode=0 and signal=1 for SIGHUP; our
    // spawnPty wrapper maps this to 128 + 1 = 129.
    expect(code).not.toBe(0);
  });
});
