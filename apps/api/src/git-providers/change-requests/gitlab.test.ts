/**
 * GitLab's vocabulary, mapped into the neutral one. Pure — the round-trips
 * themselves are e2e (and were driven against gitlab.com by hand).
 *
 * The cases that matter are where GitLab says something GitHub has no word
 * for: `detailed_merge_status`, a pipeline status standing in for a whole
 * check list, a note that is really an activity entry, and per-note
 * resolution.
 */
import { describe, expect, it } from "bun:test";
import {
  checksFromPipelineStatus,
  conflictFromMergeRequest,
  countUnresolved,
  isConflictRefusal,
  mapJob,
  mapJobStatus,
  mapNotes,
  mapState,
  parseChangesCount,
} from "./gitlab";

describe("mapState", () => {
  it("maps GitLab's four lifecycle values", () => {
    expect(mapState("opened")).toBe("open");
    expect(mapState("closed")).toBe("closed");
    expect(mapState("merged")).toBe("merged");
  });

  /** `locked` is a transient state of an OPEN merge request being merged. */
  it("reads locked as still open", () => {
    expect(mapState("locked")).toBe("open");
  });

  it("reads anything unexpected as open, never as finished", () => {
    expect(mapState(undefined)).toBe("open");
  });
});

describe("conflictFromMergeRequest", () => {
  it("takes has_conflicts when GitLab has set it", () => {
    expect(
      conflictFromMergeRequest({ state: "opened", has_conflicts: true }),
    ).toBe(true);
    expect(
      conflictFromMergeRequest({
        state: "opened",
        has_conflicts: false,
        merge_status: "cannot_be_merged",
      }),
    ).toBe(false);
  });

  /**
   * `detailed_merge_status` names the blocker precisely, and only one of its
   * values is a conflict — the others (a red pipeline, a missing approval, an
   * open discussion) are for the checks and review gates to judge.
   */
  it("reads detailed_merge_status, and only its conflict values as conflicts", () => {
    expect(
      conflictFromMergeRequest({
        state: "opened",
        detailed_merge_status: "conflict",
      }),
    ).toBe(true);
    expect(
      conflictFromMergeRequest({
        state: "opened",
        detailed_merge_status: "mergeable",
      }),
    ).toBe(false);
    for (const detailed of ["not_approved", "ci_must_pass", "draft_status"]) {
      expect(
        conflictFromMergeRequest({
          state: "opened",
          detailed_merge_status: detailed,
        }),
      ).toBeNull();
    }
  });

  it("falls back to the older merge_status", () => {
    expect(
      conflictFromMergeRequest({
        state: "opened",
        merge_status: "can_be_merged",
      }),
    ).toBe(false);
    expect(
      conflictFromMergeRequest({
        state: "opened",
        merge_status: "cannot_be_merged",
      }),
    ).toBe(true);
  });

  /** An unknown must never read as a conflict — both providers compute it late. */
  it("is null while GitLab is still checking", () => {
    expect(
      conflictFromMergeRequest({ state: "opened", merge_status: "checking" }),
    ).toBeNull();
    expect(
      conflictFromMergeRequest({ state: "opened", merge_status: "unchecked" }),
    ).toBeNull();
    expect(conflictFromMergeRequest({ state: "opened" })).toBeNull();
    expect(conflictFromMergeRequest(null)).toBeNull();
  });

  it("treats a merged or closed merge request as not conflicting", () => {
    expect(
      conflictFromMergeRequest({ state: "merged", has_conflicts: true }),
    ).toBe(false);
    expect(conflictFromMergeRequest({ state: "closed" })).toBe(false);
  });
});

describe("checksFromPipelineStatus", () => {
  /**
   * GitLab answers a richer CI signal than GitHub for free: `head_pipeline`
   * rides along on the single merge-request read, where GitHub's cheap read
   * only has the conservative `mergeable_state`.
   */
  it("maps a finished pipeline", () => {
    expect(checksFromPipelineStatus("success")).toBe("passing");
    expect(checksFromPipelineStatus("failed")).toBe("failing");
  });

  /** A run that did not finish is not evidence the head is good. */
  it("reads a cancellation as red, not as nothing", () => {
    expect(checksFromPipelineStatus("canceled")).toBe("failing");
  });

  it("maps every in-flight status to pending", () => {
    for (const status of [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "running",
      "scheduled",
    ]) {
      expect(checksFromPipelineStatus(status)).toBe("pending");
    }
  });

  it("is null for the statuses that say nothing at all", () => {
    expect(checksFromPipelineStatus("skipped")).toBeNull();
    expect(checksFromPipelineStatus("manual")).toBeNull();
    expect(checksFromPipelineStatus(undefined)).toBeNull();
  });
});

describe("mapJobStatus", () => {
  it("splits a job status into the state and conclusion pair", () => {
    expect(mapJobStatus("success")).toEqual({
      state: "completed",
      conclusion: "success",
    });
    expect(mapJobStatus("failed")).toEqual({
      state: "completed",
      conclusion: "failure",
    });
    expect(mapJobStatus("running")).toEqual({
      state: "running",
      conclusion: null,
    });
    expect(mapJobStatus("pending")).toEqual({
      state: "queued",
      conclusion: null,
    });
  });

  /** A manual job is waiting on a person, which is what action_required means. */
  it("reads a manual job as needing someone to act", () => {
    expect(mapJobStatus("manual").conclusion).toBe("action_required");
  });
});

describe("mapJob", () => {
  it("reads a job into a run, timing it from its own stamps", () => {
    expect(
      mapJob({
        id: 55,
        name: "build",
        status: "success",
        web_url: "https://gitlab.com/acme/site/-/jobs/55",
        started_at: "2026-09-01T00:00:00Z",
        finished_at: "2026-09-01T00:00:30Z",
      }),
    ).toEqual({
      id: "55",
      name: "build",
      state: "completed",
      conclusion: "success",
      url: "https://gitlab.com/acme/site/-/jobs/55",
      durationMs: 30_000,
      // A job's report is its trace, far too big to carry in a listing.
      summary: null,
    });
  });

  it("has no duration for a job that has not finished", () => {
    expect(
      mapJob({ id: 1, status: "running", started_at: "2026-09-01T00:00:00Z" })
        .durationMs,
    ).toBeNull();
  });
});

describe("mapNotes", () => {
  const url = "https://gitlab.com/acme/site/-/merge_requests/7";

  /**
   * GitLab records its own activity ("changed the description", "assigned
   * to") as notes with `system: true`. They are not comments, and counting
   * them as such is what would make a bot's preview link compete with "added
   * 1 commit".
   */
  it("drops GitLab's own activity entries", () => {
    expect(
      mapNotes(
        [
          { id: 1, body: "added 1 commit", system: true },
          { id: 2, body: "looks good", system: false },
        ],
        url,
      ),
    ).toEqual([
      {
        id: "2",
        author: "",
        body: "looks good",
        createdAt: "",
        updatedAt: "",
        url: `${url}#note_2`,
      },
    ]);
  });

  it("carries the edit time, falling back to the creation time", () => {
    const [edited, never] = mapNotes(
      [
        {
          id: 1,
          body: "a",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-06T00:00:00Z",
        },
        { id: 2, body: "b", created_at: "2026-08-03T00:00:00Z" },
      ],
      url,
    );
    expect(edited?.updatedAt).toBe("2026-08-06T00:00:00Z");
    expect(never?.updatedAt).toBe("2026-08-03T00:00:00Z");
  });
});

describe("countUnresolved", () => {
  /**
   * GitLab marks resolution per NOTE, so a thread is the unit only after
   * folding them: one unresolved note leaves the whole discussion open.
   */
  it("counts a discussion with any unresolved resolvable note", () => {
    expect(
      countUnresolved([
        { notes: [{ resolvable: true, resolved: true }] },
        {
          notes: [
            { resolvable: true, resolved: true },
            { resolvable: true, resolved: false },
          ],
        },
      ]),
    ).toBe(1);
  });

  /** A plain comment is not resolvable, so it is not an open conversation. */
  it("ignores discussions with nothing resolvable in them", () => {
    expect(
      countUnresolved([{ notes: [{ resolvable: false }] }, { notes: [] }, {}]),
    ).toBe(0);
    expect(countUnresolved([])).toBe(0);
  });
});

describe("parseChangesCount", () => {
  it("reads GitLab's string count", () => {
    expect(parseChangesCount("3")).toBe(3);
    expect(parseChangesCount(3)).toBe(3);
  });

  /** GitLab reports "1000+" past its counting limit — the number still helps. */
  it("reads the capped count as its lower bound", () => {
    expect(parseChangesCount("1000+")).toBe(1000);
  });

  it("is null when there is no count", () => {
    expect(parseChangesCount(undefined)).toBeNull();
    expect(parseChangesCount(null)).toBeNull();
    expect(parseChangesCount("many")).toBeNull();
  });
});

describe("isConflictRefusal", () => {
  /** GitLab is explicit where GitHub is not, which is why 406 needs no re-read. */
  it("is true for the status that means the branch does not apply", () => {
    expect(isConflictRefusal(406, "Branch cannot be merged")).toBe(true);
  });

  it("is true when the message names a conflict whatever the status", () => {
    expect(isConflictRefusal(405, "merge conflict detected")).toBe(true);
    expect(isConflictRefusal(409, "cannot be merged")).toBe(true);
  });

  /**
   * The bare 405 is the one that needs a re-read: it covers a draft, an
   * unresolved discussion and a red required pipeline alike.
   */
  it("is false for a refusal that says nothing about the branch", () => {
    expect(isConflictRefusal(405, "Method Not Allowed")).toBe(false);
    expect(isConflictRefusal(401, "Unauthorized")).toBe(false);
  });
});
