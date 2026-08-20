import { describe, expect, test as it } from "bun:test";
import { resolvePreviewSource } from "./preview-source";

const base = {
  harnessId: null as string | null,
  agentHasRepo: false,
  threadHasRepo: false,
  hasSandboxPreviewUrl: false,
};

describe("resolvePreviewSource", () => {
  it("previews the agent repo on a normal thread", () => {
    expect(resolvePreviewSource({ ...base, agentHasRepo: true })).toBe("repo");
  });

  it("previews a thread-scoped repo bound by load_repo", () => {
    expect(resolvePreviewSource({ ...base, threadHasRepo: true })).toBe("repo");
  });

  it("hides Preview for a repo-less claude-code sandbox run", () => {
    expect(
      resolvePreviewSource({
        ...base,
        harnessId: "claude-code",
        agentHasRepo: true,
      }),
    ).toBe("none");
  });

  it("previews the sandbox dev server of a repo-less sandbox run", () => {
    expect(
      resolvePreviewSource({
        ...base,
        harnessId: "claude-code",
        hasSandboxPreviewUrl: true,
      }),
    ).toBe("sandbox");
  });

  it("previews the thread checkout of a sandbox run that cloned a repo", () => {
    expect(
      resolvePreviewSource({
        ...base,
        harnessId: "claude-code",
        threadHasRepo: true,
      }),
    ).toBe("repo");
  });

  it("has nothing to preview without repo or dev server", () => {
    expect(resolvePreviewSource(base)).toBe("none");
  });
});
