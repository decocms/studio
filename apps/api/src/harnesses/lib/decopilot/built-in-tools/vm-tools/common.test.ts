import { describe, expect, it } from "bun:test";
import { maybeTruncate } from "./common";

describe("maybeTruncate", () => {
  it("keys the stash by the caller-supplied tool call id, not a self-minted one", () => {
    const big = "x".repeat(200_000);
    const toolOutputMap = new Map<string, string>();

    const first = maybeTruncate(big, toolOutputMap, "call_1") as {
      truncated: boolean;
      message: string;
    };
    const second = maybeTruncate(big, toolOutputMap, "call_2") as {
      truncated: boolean;
      message: string;
    };

    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    expect(first.message).toContain("call_1");
    expect(second.message).toContain("call_2");
    // Two concurrent truncations never collide on the same map key.
    expect(toolOutputMap.has("call_1")).toBe(true);
    expect(toolOutputMap.has("call_2")).toBe(true);
    expect(toolOutputMap.size).toBe(2);
  });
});
