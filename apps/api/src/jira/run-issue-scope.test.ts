import { describe, expect, it } from "bun:test";
import { pickRunIssue, runIssueKeys } from "./run-issue-scope";

describe("runIssueKeys", () => {
  it("is the stamped set", () => {
    expect(
      runIssueKeys({ source: "jira", jira_issue_keys: ["EX-1", "EX-2"] }),
    ).toEqual(["EX-1", "EX-2"]);
  });

  it("falls back to the single key a pre-batch run carries", () => {
    expect(runIssueKeys({ source: "jira", jira_issue_key: "EX-1" })).toEqual([
      "EX-1",
    ]);
  });

  it("is empty for a thread that is not a Jira run", () => {
    expect(runIssueKeys({ jira_issue_keys: ["EX-1"] })).toEqual([]);
    expect(runIssueKeys(null)).toEqual([]);
  });

  it("ignores garbage in the set", () => {
    expect(
      runIssueKeys({ source: "jira", jira_issue_keys: [1, "EX-2", null] }),
    ).toEqual(["EX-2"]);
  });
});

describe("pickRunIssue", () => {
  it("is the only issue when none is named", () => {
    expect(pickRunIssue(["EX-1"], undefined)).toBe("EX-1");
    expect(pickRunIssue(["EX-1"], "  ")).toBe("EX-1");
  });

  it("demands a key when the run spans several", () => {
    expect(() => pickRunIssue(["EX-1", "EX-2"], undefined)).toThrow(
      /2 issues \(EX-1, EX-2\)/,
    );
  });

  it("resolves a named issue in the run's own spelling", () => {
    expect(pickRunIssue(["EX-1", "EX-2"], "ex-2")).toBe("EX-2");
    expect(pickRunIssue(["EX-1"], "EX-1")).toBe("EX-1");
  });

  it("refuses an issue outside the run", () => {
    expect(() => pickRunIssue(["EX-1", "EX-2"], "EX-3")).toThrow(
      /EX-3 is not an issue this run works on/,
    );
    expect(() => pickRunIssue([], "EX-1")).toThrow(/not working on a Jira/);
  });
});
