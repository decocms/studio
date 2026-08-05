import { describe, expect, it } from "bun:test";
import { copyToClipboard } from "./download-app-dialog.tsx";

describe("copyToClipboard", () => {
  it("resolves true when writeText succeeds", async () => {
    const ok = await copyToClipboard(
      { writeText: () => Promise.resolve() },
      "curl -fsSL https://example.com/install.sh | sh",
    );
    expect(ok).toBe(true);
  });

  it("resolves false instead of throwing when clipboard is undefined", async () => {
    const ok = await copyToClipboard(undefined, "command");
    expect(ok).toBe(false);
  });

  it("resolves false instead of rejecting when writeText is denied", async () => {
    const ok = await copyToClipboard(
      { writeText: () => Promise.reject(new Error("denied")) },
      "command",
    );
    expect(ok).toBe(false);
  });
});
