import { describe, expect, it } from "bun:test";

import { snapshotKey } from "./types";

describe("snapshotKey", () => {
  it("builds the canonical 3-segment key with a .tar suffix", () => {
    expect(
      snapshotKey({
        orgId: "org-abc",
        virtualMcpId: "vmcp-123",
        branch: "main",
      }),
    ).toBe("org-abc/vmcp-123/main.tar");
  });

  it("preserves slashes inside branches as nested key segments", () => {
    expect(
      snapshotKey({
        orgId: "org-abc",
        virtualMcpId: "vmcp-123",
        branch: "deco/lucky-dolphin",
      }),
    ).toBe("org-abc/vmcp-123/deco/lucky-dolphin.tar");
  });

  it("sanitizes characters outside [a-zA-Z0-9._-] to underscore", () => {
    expect(
      snapshotKey({
        orgId: "org abc!",
        virtualMcpId: "vmcp@123",
        branch: "feature/with space",
      }),
    ).toBe("org_abc_/vmcp_123/feature/with_space.tar");
  });

  it("neutralizes `..` so it cannot survive as a path segment", () => {
    expect(
      snapshotKey({
        orgId: "..",
        virtualMcpId: "vmcp-123",
        branch: "main",
      }),
    ).toBe("_/vmcp-123/main.tar");

    expect(
      snapshotKey({
        orgId: "org-abc",
        virtualMcpId: "vmcp-123",
        branch: "../escape",
      }),
    ).toBe("org-abc/vmcp-123/_/escape.tar");
  });

  it("collapses leading dots so `.git` cannot appear as a literal component", () => {
    expect(
      snapshotKey({
        orgId: "org",
        virtualMcpId: ".hidden",
        branch: "main",
      }),
    ).toBe("org/_hidden/main.tar");
  });

  it("throws on empty inputs", () => {
    expect(() =>
      snapshotKey({ orgId: "", virtualMcpId: "v", branch: "main" }),
    ).toThrow(/orgId/);
    expect(() =>
      snapshotKey({ orgId: "o", virtualMcpId: "", branch: "main" }),
    ).toThrow(/virtualMcpId/);
    expect(() =>
      snapshotKey({ orgId: "o", virtualMcpId: "v", branch: "" }),
    ).toThrow(/branch/);
  });

  it("throws when branch sanitizes to empty (all-illegal chars)", () => {
    expect(() =>
      snapshotKey({ orgId: "o", virtualMcpId: "v", branch: "///" }),
    ).toThrow(/sanitized to empty/);
  });
});
