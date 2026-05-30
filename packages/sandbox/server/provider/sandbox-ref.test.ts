import { describe, expect, it } from "bun:test";
import { composeSandboxRef } from "./sandbox-ref";

describe("composeSandboxRef", () => {
  it("composes agent ref from org + virtualMcp + branch", () => {
    expect(
      composeSandboxRef({
        orgId: "org_123",
        virtualMcpId: "vm_abc",
        branch: "deco/silver-fox",
      }),
    ).toBe("agent:org_123:vm_abc:deco/silver-fox");
  });

  it("composes thread ref from threadId", () => {
    expect(composeSandboxRef({ threadId: "thr_xyz" })).toBe("thread:thr_xyz");
  });

  it("preserves slashes and special chars in branch (no encoding)", () => {
    // refs are opaque routing keys, not URLs — encoding is the runner's job.
    expect(
      composeSandboxRef({
        orgId: "o",
        virtualMcpId: "v",
        branch: "feat/abc-123_x.y",
      }),
    ).toBe("agent:o:v:feat/abc-123_x.y");
  });

  it("rejects empty agent fields", () => {
    expect(() =>
      composeSandboxRef({ orgId: "", virtualMcpId: "v", branch: "b" }),
    ).toThrow();
    expect(() =>
      composeSandboxRef({ orgId: "o", virtualMcpId: "", branch: "b" }),
    ).toThrow();
    expect(() =>
      composeSandboxRef({ orgId: "o", virtualMcpId: "v", branch: "" }),
    ).toThrow();
  });

  it("rejects empty threadId", () => {
    expect(() => composeSandboxRef({ threadId: "" })).toThrow();
  });
});
