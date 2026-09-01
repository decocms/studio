import { describe, expect, it } from "bun:test";
import { remoteLinkPlan } from "./remote-links";

describe("remoteLinkPlan", () => {
  const item = "board_abc";

  it("plans a PR link keyed on the card and PR number", () => {
    expect(
      remoteLinkPlan({
        taskBoardItemId: item,
        prUrl: "https://github.com/o/r/pull/7",
        prNumber: 7,
      }),
    ).toEqual([
      {
        globalId: `studio-pr:${item}:7`,
        url: "https://github.com/o/r/pull/7",
        title: "Pull request #7",
        iconUrl: "https://github.githubassets.com/favicon.ico",
      },
    ]);
  });

  it("plans one preview link per card, so a re-deploy replaces it", () => {
    const first = remoteLinkPlan({
      taskBoardItemId: item,
      previewUrl: "https://envs-x--aaa.decocdn.com",
    });
    const second = remoteLinkPlan({
      taskBoardItemId: item,
      previewUrl: "https://envs-x--bbb.decocdn.com",
    });
    expect(first[0]?.globalId).toBe(second[0]?.globalId);
    expect(first[0]?.url).not.toBe(second[0]?.url);
    expect(first[0]?.title).toBe("Deploy preview");
  });

  it("drops a preview on an untrusted host", () => {
    // The preview is lifted from PR comments an outside contributor can write,
    // and this link lands on a customer's issue.
    expect(
      remoteLinkPlan({
        taskBoardItemId: item,
        previewUrl: "https://evil.example.com/x?y=.decocdn.com",
      }),
    ).toEqual([]);
  });

  it("drops a non-http target and plans nothing when there is nothing to link", () => {
    expect(
      remoteLinkPlan({ taskBoardItemId: item, prUrl: "javascript:alert(1)" }),
    ).toEqual([]);
    expect(remoteLinkPlan({ taskBoardItemId: item })).toEqual([]);
  });

  it("plans both links in a stable order", () => {
    const plan = remoteLinkPlan({
      taskBoardItemId: item,
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      previewUrl: "https://envs-x--aaa.decocdn.com",
    });
    expect(plan.map((l) => l.title)).toEqual([
      "Pull request #7",
      "Deploy preview",
    ]);
  });
});
