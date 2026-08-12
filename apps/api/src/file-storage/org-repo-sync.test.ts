import { describe, expect, it } from "bun:test";
import { validateSyncVolumeName } from "./org-repo-sync";

describe("validateSyncVolumeName", () => {
  it("accepts ordinary volume names", () => {
    expect(validateSyncVolumeName("my-skills")).toBeNull();
    expect(validateSyncVolumeName("Repo_1.2")).toBeNull();
  });

  it("rejects reserved volumes (including the daemon's output/upload links)", () => {
    for (const name of [
      "home",
      "outputs",
      "uploads",
      "public",
      "output",
      "upload",
    ]) {
      expect(validateSyncVolumeName(name)).toContain("reserved");
    }
  });

  it("rejects names skill-resolve's SAFE_SEGMENT can't parse", () => {
    expect(validateSyncVolumeName("_skills")).toContain("start with");
    expect(validateSyncVolumeName("-skills")).toContain("start with");
  });

  it("rejects the public-set namespace", () => {
    expect(validateSyncVolumeName("public-core")).toContain("reserved");
  });

  it("rejects dot-prefixed names (hidden mounts)", () => {
    expect(validateSyncVolumeName(".outputs")).toContain("reserved");
  });

  it("rejects names the volume grammar refuses", () => {
    expect(validateSyncVolumeName("")).toContain("Invalid");
    expect(validateSyncVolumeName("a/b")).toContain("Invalid");
    expect(validateSyncVolumeName("..")).toContain("Invalid");
    expect(validateSyncVolumeName("x".repeat(129))).toContain("Invalid");
  });
});
