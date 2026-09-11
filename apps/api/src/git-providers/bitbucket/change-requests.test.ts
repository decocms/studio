import { describe, expect, test } from "bun:test";
import {
  conflictFromDiffstat,
  countUnresolved,
  isConflictRefusal,
  mapComments,
  mapCommitStatus,
  mapState,
  mapStatusState,
  reviewBlockedFrom,
} from "./change-requests";

describe("mapState", () => {
  test("maps Bitbucket's four lifecycle values", () => {
    expect(mapState("OPEN")).toBe("open");
    expect(mapState("MERGED")).toBe("merged");
    expect(mapState("DECLINED")).toBe("closed");
    expect(mapState("SUPERSEDED")).toBe("closed");
  });
  test("reads anything unexpected as open, never as finished", () => {
    expect(mapState(undefined)).toBe("open");
    expect(mapState("weird")).toBe("open");
  });
});

describe("mapStatusState", () => {
  test("splits a commit status into the state and conclusion pair", () => {
    expect(mapStatusState("SUCCESSFUL")).toEqual({
      state: "completed",
      conclusion: "success",
    });
    expect(mapStatusState("FAILED")).toEqual({
      state: "completed",
      conclusion: "failure",
    });
    expect(mapStatusState("INPROGRESS")).toEqual({
      state: "running",
      conclusion: null,
    });
  });
  test("reads a stopped build as red, not as nothing", () => {
    expect(mapStatusState("STOPPED")).toEqual({
      state: "completed",
      conclusion: "cancelled",
    });
  });
  test("anything unknown is still queued", () => {
    expect(mapStatusState(null)).toEqual({ state: "queued", conclusion: null });
  });
});

describe("mapCommitStatus", () => {
  test("reads a status into a run, timing it from its own stamps", () => {
    expect(
      mapCommitStatus({
        key: "ci/build",
        name: "Build",
        state: "SUCCESSFUL",
        url: "https://ci.example/1",
        description: "all green",
        created_on: "2026-09-11T12:00:00Z",
        updated_on: "2026-09-11T12:02:30Z",
      }),
    ).toEqual({
      id: "ci/build",
      name: "Build",
      state: "completed",
      conclusion: "success",
      url: "https://ci.example/1",
      durationMs: 150_000,
      summary: "all green",
    });
  });
  test("has no duration while running", () => {
    expect(
      mapCommitStatus({
        key: "ci",
        state: "INPROGRESS",
        created_on: "2026-09-11T12:00:00Z",
        updated_on: "2026-09-11T12:01:00Z",
      }).durationMs,
    ).toBeNull();
  });
});

describe("mapComments / countUnresolved", () => {
  const comments = [
    {
      id: 1,
      content: { raw: "Looks good" },
      user: { nickname: "ada" },
      created_on: "2026-09-11T12:00:00Z",
      updated_on: "2026-09-11T12:05:00Z",
      links: {
        html: { href: "https://bitbucket.org/a/s/pull-requests/1#comment-1" },
      },
    },
    {
      id: 2,
      content: { raw: "Preview: https://preview.example" },
      user: { nickname: "bot" },
      created_on: "2026-09-11T11:00:00Z",
    },
    {
      id: 3,
      content: { raw: "rename this" },
      user: { nickname: "ada" },
      created_on: "2026-09-11T12:01:00Z",
      inline: { path: "a.ts" },
    },
    {
      id: 4,
      content: { raw: "done" },
      user: { nickname: "bob" },
      created_on: "2026-09-11T12:02:00Z",
      inline: { path: "a.ts" },
      parent: { id: 3 },
    },
    {
      id: 5,
      content: { raw: "resolved thread" },
      created_on: "2026-09-11T12:03:00Z",
      inline: { path: "b.ts" },
      resolution: { type: "resolution" },
    },
    {
      id: 6,
      content: { raw: "gone" },
      deleted: true,
      created_on: "2026-09-11T12:04:00Z",
    },
  ];

  test("keeps only live comments on the pull request itself, oldest first", () => {
    const mapped = mapComments(
      comments,
      "https://bitbucket.org/a/s/pull-requests/1",
    );
    expect(mapped.map((c) => c.id)).toEqual(["2", "1"]);
    expect(mapped[1]).toEqual({
      id: "1",
      author: "ada",
      body: "Looks good",
      createdAt: "2026-09-11T12:00:00Z",
      updatedAt: "2026-09-11T12:05:00Z",
      url: "https://bitbucket.org/a/s/pull-requests/1#comment-1",
    });
    // No edit time: the creation time stands in.
    expect(mapped[0]!.updatedAt).toBe("2026-09-11T11:00:00Z");
  });

  test("counts live, top-level inline threads with no resolution", () => {
    expect(countUnresolved(comments)).toBe(1);
  });
});

describe("conflictFromDiffstat", () => {
  test("null when the diffstat could not be read", () => {
    expect(conflictFromDiffstat(null)).toBeNull();
  });
  test("true only when an entry is a merge conflict", () => {
    expect(conflictFromDiffstat([{ status: "modified" }])).toBe(false);
    expect(
      conflictFromDiffstat([
        { status: "modified" },
        { status: "merge conflict" },
      ]),
    ).toBe(true);
  });
});

describe("reviewBlockedFrom", () => {
  test("someone asked for changes", () => {
    expect(
      reviewBlockedFrom({
        participants: [{ state: "approved" }, { state: "changes_requested" }],
      }),
    ).toBe(true);
    expect(reviewBlockedFrom({ participants: [{ state: "approved" }] })).toBe(
      false,
    );
    expect(reviewBlockedFrom({})).toBe(false);
  });
});

describe("refusal prose", () => {
  test("a conflict names itself", () => {
    expect(isConflictRefusal("There are merge conflicts")).toBe(true);
    expect(isConflictRefusal("You need two approvals")).toBe(false);
  });
});
