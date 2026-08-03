import { describe, expect, it } from "bun:test";
import {
  offloadKey,
  parseMessagesRef,
  sha256Hex,
  shouldOffload,
  type MessagesRef,
} from "./offload-messages";

describe("offload-messages (pure)", () => {
  it("keys by reqId under the ephemeral prefix", () => {
    expect(offloadKey("req-123")).toBe("link-dispatch/req-123");
  });

  it("offloads only above the byte budget", () => {
    expect(shouldOffload(100)).toBe(false);
    expect(shouldOffload(768 * 1024 + 1)).toBe(true);
  });

  it("round-trips a messagesRef envelope", () => {
    const ref: MessagesRef = { url: "https://s/x", bytes: 5, sha256: "ab" };
    const env = { harnessId: "claude-code", input: { a: 1 }, messagesRef: ref };
    expect(parseMessagesRef(env)).toEqual(ref);
    expect(parseMessagesRef({ harnessId: "x", input: {} })).toBeNull();
  });

  it("computes sha256 of known input", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("abc"));
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
