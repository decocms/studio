import { describe, expect, it } from "bun:test";
import { buildCuratorTranscript } from "./interests-curator";

describe("buildCuratorTranscript", () => {
  it("includes user and assistant turns", () => {
    const t = buildCuratorTranscript([
      { role: "user", content: "I want to learn Rust" },
      { role: "assistant", content: "Great, start with ownership" },
    ]);
    expect(t).toContain("user: I want to learn Rust");
    expect(t).toContain("assistant: Great, start with ownership");
  });

  it("extracts text from array content parts", () => {
    const t = buildCuratorTranscript([
      { role: "user", content: [{ type: "text", text: "hello there" }] },
    ]);
    expect(t).toContain("user: hello there");
  });

  it("skips non-user/assistant roles and empty turns", () => {
    const t = buildCuratorTranscript([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "" },
      { role: "assistant", content: "hi" },
    ]);
    expect(t).not.toContain("system");
    expect(t).toBe("assistant: hi");
  });
});
