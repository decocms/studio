import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { fileURLToPath } from "node:url";
import { isStudioCliCommand, runStudioCli, STUDIO_CLI_COMMANDS } from "./index";

let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  out = [];
  err = [];
  logSpy = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    out.push(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stdout.write);
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

describe("exitAfterFlush", () => {
  /** A slow pipe reader is what exposed the cut: the OS buffer (64 KB) fills
   *  and anything still queued when the process exits is lost. */
  it("delivers large piped output to a slow reader before exiting", async () => {
    const index = fileURLToPath(new URL("./index.ts", import.meta.url));
    const script = `
      import { exitAfterFlush } from ${JSON.stringify(index)};
      process.stdout.write("x".repeat(6_000_000) + "\\n");
      await exitAfterFlush(3);
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
    const reader = proc.stdout.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      await Bun.sleep(1);
    }
    expect(await proc.exited).toBe(3);
    expect(bytes).toBe(6_000_001);
  });
});
