import { describe, expect, test } from "bun:test";
import * as tpl from "./message-templates";

describe("message-templates", () => {
  test("commitAndPush references the branch + mentions commit and push", () => {
    const out = tpl.commitAndPush({ branch: "feat/x" });
    expect(out).toContain("feat/x");
    expect(out.toLowerCase()).toContain("commit");
    expect(out.toLowerCase()).toContain("push");
  });

  test("createPr references the branch and mentions pull request", () => {
    const out = tpl.createPr({ branch: "feat/x" });
    expect(out).toContain("feat/x");
    expect(out.toLowerCase()).toContain("pull request");
  });

  test("reopenPr references the PR number", () => {
    const out = tpl.reopenPr({ prNumber: 42 });
    expect(out).toContain("#42");
    expect(out.toLowerCase()).toContain("reopen");
  });

  test("rebaseOnBase references the branch + mentions rebase and force-push", () => {
    const out = tpl.rebaseOnBase({ branch: "feat/x" });
    expect(out).toContain("feat/x");
    expect(out.toLowerCase()).toContain("rebase");
    expect(out.toLowerCase()).toContain("force-push");
  });

  test("fixChecks references PR + lists failing checks", () => {
    const out = tpl.fixChecks({
      prNumber: 42,
      failingChecks: ["lint", "unit-test"],
    });
    expect(out).toContain("#42");
    expect(out).toContain("lint");
    expect(out).toContain("unit-test");
    expect(out.toLowerCase()).toContain("commit");
    expect(out.toLowerCase()).toContain("push");
  });

  test("markReadyForReview references the PR number", () => {
    const out = tpl.markReadyForReview({ prNumber: 42 });
    expect(out).toContain("#42");
    expect(out.toLowerCase()).toContain("ready for review");
  });

  test("resolveReviewComments references the PR number", () => {
    const out = tpl.resolveReviewComments({ prNumber: 42 });
    expect(out).toContain("#42");
    expect(out.toLowerCase()).toContain("resolve");
    expect(out.toLowerCase()).toContain("push");
  });

  test("reviewPr references the PR number + read-and-comment pass", () => {
    const out = tpl.reviewPr({ prNumber: 42 });
    expect(out).toContain("#42");
    expect(out.toLowerCase()).toContain("review");
    expect(out.toLowerCase()).toContain("not modify");
  });

  test("mergeSquash references the PR number", () => {
    const out = tpl.mergeSquash({ prNumber: 42 });
    expect(out).toContain("#42");
    expect(out.toLowerCase()).toContain("squash-merge");
  });

  test("rerunCheck references PR + check name", () => {
    const out = tpl.rerunCheck({ prNumber: 42, checkName: "lint" });
    expect(out).toContain("#42");
    expect(out).toContain("lint");
    expect(out.toLowerCase()).toContain("re-run");
  });

  test("all templates include the button-confirmed reinforcement", () => {
    const outputs = [
      tpl.commitAndPush({ branch: "x" }),
      tpl.createPr({ branch: "x" }),
      tpl.reopenPr({ prNumber: 1 }),
      tpl.rebaseOnBase({ branch: "x" }),
      tpl.fixChecks({ prNumber: 1, failingChecks: ["a"] }),
      tpl.markReadyForReview({ prNumber: 1 }),
      tpl.resolveReviewComments({ prNumber: 1 }),
      tpl.reviewPr({ prNumber: 1 }),
      tpl.mergeSquash({ prNumber: 1 }),
      tpl.rerunCheck({ prNumber: 1, checkName: "a" }),
    ];
    for (const out of outputs) {
      expect(out.toLowerCase()).toContain("user clicked this action");
      expect(out.toLowerCase()).toContain("user_ask");
    }
  });
});
