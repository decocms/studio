import { describe, expect, it } from "bun:test";
import {
  computeBranchDivergence,
  type GitTryRunner,
} from "./branch-divergence";

function fakeGit(responses: Record<string, string | null>): GitTryRunner {
  return (args) => {
    const key = args.join(" ");
    return key in responses ? responses[key] : null;
  };
}

describe("computeBranchDivergence", () => {
  it("returns early with zero counts when HEAD is detached", () => {
    const result = computeBranchDivergence(
      "/repo",
      fakeGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse --abbrev-ref HEAD": "HEAD",
        "rev-parse HEAD": "abc123",
      }),
    );
    expect(result).toEqual({
      base: "main",
      aheadOfBase: 0,
      behindBase: 0,
      headSha: "abc123",
      unpushed: 0,
    });
  });

  it("falls back to main when origin/HEAD symbolic-ref is unavailable", () => {
    const result = computeBranchDivergence(
      "/repo",
      fakeGit({
        "rev-parse --abbrev-ref HEAD": "feature/x",
        "rev-parse --verify --quiet origin/feature/x": null,
        "rev-parse --verify --quiet origin/main": null,
        "rev-parse HEAD": "deadbeef",
      }),
    );
    expect(result.base).toBe("main");
    expect(result.aheadOfBase).toBe(0);
    expect(result.behindBase).toBe(0);
  });

  it("treats all local commits ahead as unpushed when the branch was never pushed", () => {
    const result = computeBranchDivergence(
      "/repo",
      fakeGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse --abbrev-ref HEAD": "feature/x",
        "rev-parse --verify --quiet origin/feature/x": null,
        "rev-parse --verify --quiet origin/main": "sha",
        "rev-list --left-right --count origin/main...HEAD": "0\t3",
        "rev-parse HEAD": "headsha",
      }),
    );
    expect(result.aheadOfBase).toBe(3);
    expect(result.behindBase).toBe(0);
    expect(result.unpushed).toBe(3);
    expect(result.headSha).toBe("headsha");
  });

  it("computes unpushed from the remote branch when one exists", () => {
    const result = computeBranchDivergence(
      "/repo",
      fakeGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
        "rev-parse --abbrev-ref HEAD": "feature/x",
        "rev-parse --verify --quiet origin/feature/x": "sha",
        "rev-parse --verify --quiet origin/main": "sha",
        "rev-list --left-right --count origin/main...origin/feature/x": "2\t5",
        "rev-list --count origin/feature/x..HEAD": "1",
        "rev-parse origin/feature/x": "remotesha",
      }),
    );
    expect(result.behindBase).toBe(2);
    expect(result.aheadOfBase).toBe(5);
    expect(result.unpushed).toBe(1);
    expect(result.headSha).toBe("remotesha");
  });
});
