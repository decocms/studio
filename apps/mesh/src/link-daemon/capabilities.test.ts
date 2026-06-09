import { describe, expect, it } from "bun:test";
import { detectCapabilities } from "./capabilities";

describe("detectCapabilities", () => {
  it("always includes decopilot-sandbox and body-offload", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => false,
      detectCodex: async () => false,
    });
    expect(caps).toEqual(["decopilot-sandbox", "body-offload"]);
  });

  it("always advertises body-offload (daemon-code capability, unconditional)", async () => {
    // body-offload is never conditioned on an external probe — the daemon
    // build always includes re-inflate support, so it must always be advertised.
    for (const [cc, cx] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as Array<[boolean, boolean]>) {
      const caps = await detectCapabilities({
        detectClaudeCode: async () => cc,
        detectCodex: async () => cx,
      });
      expect(caps).toContain("body-offload");
    }
  });

  it("includes claude-code when probe succeeds", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => true,
      detectCodex: async () => false,
    });
    expect(caps).toEqual(["decopilot-sandbox", "body-offload", "claude-code"]);
  });

  it("includes codex when probe succeeds", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => false,
      detectCodex: async () => true,
    });
    expect(caps).toEqual(["decopilot-sandbox", "body-offload", "codex"]);
  });

  it("includes both when both probes succeed", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => true,
      detectCodex: async () => true,
    });
    expect(caps).toEqual([
      "decopilot-sandbox",
      "body-offload",
      "claude-code",
      "codex",
    ]);
  });

  it("treats throwing probes as false", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => {
        throw new Error("not found");
      },
      detectCodex: async () => {
        throw new Error("oops");
      },
    });
    expect(caps).toEqual(["decopilot-sandbox", "body-offload"]);
  });
});
