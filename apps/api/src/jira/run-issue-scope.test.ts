import { describe, expect, it } from "bun:test";
import {
  pickIssue,
  runCreatedIssueKeys,
  runIssueKeys,
} from "./run-issue-scope";

describe("runCreatedIssueKeys", () => {
  it("is the run's own creations, and nothing on a thread that is not a Jira run", () => {
    expect(
      runCreatedIssueKeys({
        source: "jira",
        jira_issue_keys: ["EX-1"],
        jira_created_issue_keys: ["EX-9", 3],
      }),
    ).toEqual(["EX-9"]);
    expect(runCreatedIssueKeys({ jira_created_issue_keys: ["EX-9"] })).toEqual(
      [],
    );
    expect(runCreatedIssueKeys({ source: "jira" })).toEqual([]);
  });
});

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

describe("pickIssue", () => {
  it("is the only issue when none is named", () => {
    expect(pickIssue(["EX-1"], undefined)).toEqual({
      key: "EX-1",
      inRun: true,
    });
    expect(pickIssue(["EX-1"], "  ")).toEqual({ key: "EX-1", inRun: true });
  });

  it("demands a key when the run spans several", () => {
    expect(() => pickIssue(["EX-1", "EX-2"], undefined)).toThrow(
      /2 issues \(EX-1, EX-2\)/,
    );
  });

  it("resolves a run issue in the run's own spelling", () => {
    expect(pickIssue(["EX-1", "EX-2"], "ex-2")).toEqual({
      key: "EX-2",
      inRun: true,
    });
  });

  it("passes any other key on, marked for the board check", () => {
    expect(pickIssue(["EX-1"], " ex-30 ")).toEqual({
      key: "EX-30",
      inRun: false,
    });
  });

  it("refuses what is not an issue key", () => {
    for (const bad of ["EX", "12", "EX-1/../x", "EX-1 OR key = X-2"]) {
      expect(() => pickIssue(["EX-1"], bad)).toThrow(/not a Jira issue key/);
    }
    expect(() => pickIssue([], "EX-1")).toThrow(/not working on a Jira/);
  });
});
