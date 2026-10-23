import { describe, expect, it } from "bun:test";
import { settleAfterPublish } from "./publish-completion";

function run(hosted: boolean, branch: string) {
  const calls: string[] = [];
  return settleAfterPublish({
    hosted,
    branch,
    baseBranch: "main",
    nextBranch: () => "ana-2",
    setCurrentTaskBranch: (b) => {
      calls.push(`switch ${b}`);
    },
    deleteRelease: (b) => {
      calls.push(`delete ${b}`);
    },
  }).then(() => calls);
}

describe("settleAfterPublish", () => {
  it("v7: lands on a fresh draft and discards the published one", async () => {
    expect(await run(false, "ana-1")).toEqual(["switch ana-2", "delete ana-1"]);
  });

  it("hosted v8: stays on the same draft (same branch, same switcher entry)", async () => {
    expect(await run(true, "ana-1")).toEqual([]);
    expect(await run(true, "main")).toEqual([]);
  });
});
