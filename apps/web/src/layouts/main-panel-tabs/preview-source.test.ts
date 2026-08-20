import { describe, expect, test as it } from "bun:test";
import { resolvePreviewSource } from "./preview-source";

const base = {
  threadId: "t1",
  sandboxBranch: null as string | null,
  agentHasRepo: false,
  threadHasRepo: false,
};

describe("resolvePreviewSource", () => {
  it("previews the agent repo on a normal thread", () => {
    expect(resolvePreviewSource({ ...base, agentHasRepo: true })).toBe("repo");
  });

  it("previews a thread-scoped repo bound by load_repo", () => {
    expect(resolvePreviewSource({ ...base, threadHasRepo: true })).toBe("repo");
  });

  it("keeps the agent repo on a claude-code thread of a GitHub project", () => {
    // The mainstream Claude Code flow: repo lives on the AGENT, the sandbox is
    // that repo's checkout, the thread carries a minted git branch and no
    // thread-level githubRepo. Preview and Code must stay.
    expect(
      resolvePreviewSource({
        ...base,
        sandboxBranch: "user-alice-1712000000",
        agentHasRepo: true,
      }),
    ).toBe("repo");
  });

  it("hides Preview for a repo-less sandbox task run", () => {
    expect(
      resolvePreviewSource({
        ...base,
        sandboxBranch: "thread:t1",
        agentHasRepo: true,
      }),
    ).toBe("none");
  });

  it("previews the repo a sandbox task run bound mid-run", () => {
    // TASK_ADD_REPO writes metadata.githubRepo and leaves the bare key alone.
    expect(
      resolvePreviewSource({
        ...base,
        sandboxBranch: "thread:t1",
        threadHasRepo: true,
      }),
    ).toBe("repo");
  });

  it("previews a load_repo sandbox key (repo connection id attached)", () => {
    expect(
      resolvePreviewSource({
        ...base,
        sandboxBranch: "thread:t1/conn_1",
        agentHasRepo: true,
      }),
    ).toBe("repo");
  });

  it("does not mistake another thread's bare key for this thread's", () => {
    expect(
      resolvePreviewSource({
        ...base,
        sandboxBranch: "thread:t2",
        agentHasRepo: true,
      }),
    ).toBe("repo");
  });

  it("has nothing to preview without any repo", () => {
    expect(resolvePreviewSource(base)).toBe("none");
  });
});
