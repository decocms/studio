import { describe, expect, it } from "bun:test";
import pkg from "./package.json";

describe("@decocms/harness package metadata", () => {
  it("is the singular, module-type, no-build package", () => {
    expect(pkg.name).toBe("@decocms/harness");
    expect(pkg.type).toBe("module");
    expect(pkg.scripts?.build).toBeUndefined();
  });
  it("declares ai as a peer dependency (>=6)", () => {
    expect(pkg.peerDependencies?.ai).toBe(">=6.0.0");
  });
  it("exposes the pinned subpath exports", () => {
    for (const sub of [
      ".",
      "./types",
      "./registry",
      "./claude-code",
      "./codex",
      "./decopilot",
      "./sources",
    ]) {
      expect(pkg.exports[sub]).toBeDefined();
    }
  });
});
