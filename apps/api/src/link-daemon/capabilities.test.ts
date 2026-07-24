import { describe, expect, it } from "bun:test";
import { sleep } from "@decocms/shared/std";
import type { Capability } from "@/links/protocol";
import {
  detectCapabilities,
  mergeProbedCapabilities,
  missingCliCapabilities,
  startCapabilityReprobe,
} from "./capabilities";

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

describe("missingCliCapabilities", () => {
  it("reports both CLIs missing on a bare daemon", () => {
    expect(
      missingCliCapabilities(["decopilot-sandbox", "body-offload"]),
    ).toEqual(["claude-code", "codex"]);
  });

  it("reports nothing missing when both CLIs are present", () => {
    expect(
      missingCliCapabilities([
        "decopilot-sandbox",
        "body-offload",
        "claude-code",
        "codex",
      ]),
    ).toEqual([]);
  });
});

describe("mergeProbedCapabilities", () => {
  it("grows the array in place with newly probed capabilities", () => {
    const live: Capability[] = ["decopilot-sandbox", "body-offload"];
    const added = mergeProbedCapabilities(live, [
      "decopilot-sandbox",
      "body-offload",
      "claude-code",
    ]);
    expect(added).toEqual(["claude-code"]);
    expect(live).toEqual(["decopilot-sandbox", "body-offload", "claude-code"]);
  });

  it("never removes a capability the probe stopped reporting (grow-only)", () => {
    // A transient probe failure must not un-advertise a capability mid-run —
    // dispatch routing would bounce threads that are actively streaming.
    const live: Capability[] = [
      "decopilot-sandbox",
      "body-offload",
      "claude-code",
    ];
    const added = mergeProbedCapabilities(live, [
      "decopilot-sandbox",
      "body-offload",
    ]);
    expect(added).toEqual([]);
    expect(live).toContain("claude-code");
  });
});

describe("startCapabilityReprobe", () => {
  it("skips probing while no CLI capability is missing, probes and merges while one is", async () => {
    const fullyEquipped: Capability[] = [
      "decopilot-sandbox",
      "body-offload",
      "claude-code",
      "codex",
    ];
    let probes = 0;
    const stopFull = startCapabilityReprobe(fullyEquipped, {
      intervalMs: 5,
      detect: async () => {
        probes++;
        return fullyEquipped;
      },
    });
    await sleep(25);
    stopFull();
    expect(probes).toBe(0);

    const bare: Capability[] = ["decopilot-sandbox", "body-offload"];
    const changes: Capability[][] = [];
    const stopBare = startCapabilityReprobe(bare, {
      intervalMs: 5,
      detect: async () => ["decopilot-sandbox", "body-offload", "claude-code"],
      onChange: (added) => changes.push(added),
    });
    await sleep(25);
    stopBare();
    expect(bare).toContain("claude-code");
    expect(changes).toEqual([["claude-code"]]);
  });
});
