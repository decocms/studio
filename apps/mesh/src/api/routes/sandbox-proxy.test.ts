import { describe, expect, it } from "bun:test";
import { redactRepoDir } from "./sandbox-proxy";

describe("redactRepoDir", () => {
  it("nulls a container-internal repoDir while preserving other fields", () => {
    const input = JSON.stringify({
      bootId: "boot-1",
      ready: true,
      repoDir: "/app/repo",
    });
    const out = JSON.parse(redactRepoDir(input));
    expect(out).toEqual({ bootId: "boot-1", ready: true, repoDir: null });
  });

  it("nulls repoDir even when it is already null (no-op semantics)", () => {
    const out = JSON.parse(redactRepoDir(JSON.stringify({ repoDir: null })));
    expect(out.repoDir).toBeNull();
  });

  it("leaves a payload without a repoDir key untouched", () => {
    const input = JSON.stringify({ bootId: "boot-1", ready: false });
    expect(redactRepoDir(input)).toBe(input);
  });

  it("passes through non-JSON bodies unchanged", () => {
    expect(redactRepoDir("not json")).toBe("not json");
    expect(redactRepoDir("")).toBe("");
  });

  it("passes through JSON that is not an object", () => {
    expect(redactRepoDir("[1,2,3]")).toBe("[1,2,3]");
    expect(redactRepoDir('"repoDir"')).toBe('"repoDir"');
  });
});
