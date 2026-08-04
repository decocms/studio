import { describe, expect, it } from "bun:test";
import { composeSandboxRef, refSlugSource } from "./sandbox-ref";

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

describe("refSlugSource", () => {
  it("returns the branch of an agent ref", () => {
    expect(refSlugSource("agent:org_1:vm_2:deco/silver-fox")).toBe(
      "deco/silver-fox",
    );
  });

  it("keeps every segment past the third, so a branch may contain ':'", () => {
    // A thread-scoped branch is itself `thread:<threadId>/<connId>`; splitting
    // on ":" and taking parts[3] alone would truncate it to "thread".
    expect(refSlugSource("agent:o:v:thread:thrd_abc/conn_Def")).toBe(
      "thread:thrd_abc/conn_Def",
    );
  });

  it("returns the threadId of a thread ref", () => {
    expect(refSlugSource("thread:thr_xyz")).toBe("thr_xyz");
  });

  it("returns '' for a ref in neither encoding", () => {
    expect(refSlugSource("legacy-opaque")).toBe("");
  });

  it("returns '' for a truncated agent ref", () => {
    expect(refSlugSource("agent:org:vmcp")).toBe("");
  });

  it("round-trips composeSandboxRef for both encodings", () => {
    const branch = "thread:thrd_1/conn_2";
    expect(
      refSlugSource(
        composeSandboxRef({ orgId: "o", virtualMcpId: "v", branch }),
      ),
    ).toBe(branch);
    expect(refSlugSource(composeSandboxRef({ threadId: "t_1" }))).toBe("t_1");
  });
});
