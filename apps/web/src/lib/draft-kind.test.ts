import { describe, expect, test } from "bun:test";
import { defaultThreadRuntime } from "@decocms/shared/thread/session-runtime";
import {
  blogThreadDefaults,
  draftAfterPublish,
  draftNameKey,
  nextDraftBranch,
  draftsForView,
  siblingDraft,
  isEntryCandidate,
  viewAcceptsThread,
  viewDraftKind,
  viewForThreadSwitch,
} from "./draft-kind";

/** A project whose new threads default to Fast Preview, and one that doesn't. */
const fastPreviewProject = {
  previewServerUrl: "https://site.example",
  fastPreview: true,
};
const sandboxProject = {};

const thread = (
  branch: string | null,
  runtime?: "cms" | "sandbox",
  partial?: true,
) => ({
  branch,
  metadata: runtime ? { runtime } : {},
  ...(partial ? { partial } : {}),
});

describe("viewDraftKind", () => {
  test("Blog's list and post screen are Blog", () => {
    expect(viewDraftKind("blog")).toBe("blog");
    expect(viewDraftKind("blog-post")).toBe("blog");
  });

  test("the views under the site's draft bar are the site's", () => {
    for (const view of ["site-editor", "content", "code", "calendar"]) {
      expect(viewDraftKind(view)).toBe("site");
    }
    // Monitor's Experiments view, the only one of its views with the bar.
    expect(viewDraftKind("monitoring", "experiments")).toBe("site");
  });

  test("any other view has no draft kind", () => {
    expect(viewDraftKind("settings")).toBeNull();
    expect(viewDraftKind("overview")).toBeNull();
    expect(viewDraftKind("monitoring")).toBeNull();
    expect(viewDraftKind("monitoring", "audience")).toBeNull();
    expect(viewDraftKind(undefined)).toBeNull();
  });
});

describe("draftNameKey", () => {
  test("a Blog draft is named apart from the site's drafts", () => {
    expect(draftNameKey("blog-draft-sacci-abc")).toBe(
      "thread.branchPicker.blogDraftName",
    );
    expect(draftNameKey("sacci-abc")).toBe(
      "thread.branchPicker.defaultVersionName",
    );
    expect(draftNameKey(null)).toBe("thread.branchPicker.defaultVersionName");
  });
});

describe("viewAcceptsThread", () => {
  test("Blog takes its own drafts in either runtime", () => {
    for (const runtime of ["cms", "sandbox", undefined] as const) {
      expect(
        viewAcceptsThread(
          "blog",
          thread("blog-draft-a", runtime),
          fastPreviewProject,
        ),
      ).toBe(true);
    }
  });

  test("Blog takes any sandbox, including a branch adopted from Advanced", () => {
    expect(
      viewAcceptsThread(
        "blog",
        thread("feature/x", "sandbox"),
        fastPreviewProject,
      ),
    ).toBe(true);
  });

  test("Blog refuses a site draft in Fast Preview, stamped or by the project's default", () => {
    expect(
      viewAcceptsThread("blog", thread("sacci-a", "cms"), sandboxProject),
    ).toBe(false);
    // Unstamped: the project's default, which is Fast Preview here.
    expect(
      viewAcceptsThread("blog", thread("sacci-a"), fastPreviewProject),
    ).toBe(false);
  });

  test("the site views refuse a Blog draft, whatever its runtime", () => {
    expect(
      viewAcceptsThread(
        "site",
        thread("blog-draft-a", "sandbox"),
        sandboxProject,
      ),
    ).toBe(false);
    expect(
      viewAcceptsThread("site", thread("sacci-a", "sandbox"), sandboxProject),
    ).toBe(true);
    expect(
      viewAcceptsThread(null, thread("blog-draft-a"), sandboxProject),
    ).toBe(true);
  });
});

/**
 * An entry the view would then refuse is sent to look for an entry again, and
 * finds the same one: a redirect loop. So every entry must be accepted.
 */
describe("isEntryCandidate", () => {
  const cases = [
    thread("blog-draft-a", "sandbox"),
    thread("blog-draft-a", "cms"),
    thread("blog-draft-a"),
    thread("sacci-a", "sandbox"),
    thread("sacci-a", "cms"),
    thread("sacci-a"),
    thread("blog-draft-a", "sandbox", true),
  ];

  test("every entry is a thread its view accepts", () => {
    for (const kind of ["blog", "site", null] as const) {
      for (const project of [fastPreviewProject, sandboxProject]) {
        for (const candidate of cases) {
          if (isEntryCandidate(kind, candidate, project)) {
            expect(viewAcceptsThread(kind, candidate, project)).toBe(true);
          }
        }
      }
    }
  });

  test("Blog resumes only its own drafts, in the project's runtime", () => {
    expect(
      isEntryCandidate(
        "blog",
        thread("blog-draft-a", "cms"),
        fastPreviewProject,
      ),
    ).toBe(true);
    // Unstamped reads as the project's default.
    expect(
      isEntryCandidate("blog", thread("blog-draft-a"), fastPreviewProject),
    ).toBe(true);
    expect(
      isEntryCandidate(
        "blog",
        thread("blog-draft-a", "sandbox"),
        fastPreviewProject,
      ),
    ).toBe(false);
    expect(
      isEntryCandidate(
        "blog",
        thread("blog-draft-a", "sandbox"),
        sandboxProject,
      ),
    ).toBe(true);
    expect(
      isEntryCandidate("blog", thread("sacci-a", "sandbox"), sandboxProject),
    ).toBe(false);
  });

  test("every other view skips Blog drafts and keeps the project default", () => {
    expect(
      isEntryCandidate(
        "site",
        thread("blog-draft-a", "sandbox"),
        sandboxProject,
      ),
    ).toBe(false);
    expect(
      isEntryCandidate(null, thread("blog-draft-a", "sandbox"), sandboxProject),
    ).toBe(false);
    expect(
      isEntryCandidate("site", thread("sacci-a", "cms"), fastPreviewProject),
    ).toBe(true);
    expect(
      isEntryCandidate(
        "site",
        thread("sacci-a", "sandbox"),
        fastPreviewProject,
      ),
    ).toBe(false);
  });

  test("a partial row is never an entry", () => {
    expect(
      isEntryCandidate(
        "blog",
        thread("blog-draft-a", "sandbox", true),
        sandboxProject,
      ),
    ).toBe(false);
  });
});

describe("threads created from Blog", () => {
  test("keep the branch they were given, else mint a Blog draft", () => {
    expect(blogThreadDefaults("blog-draft-sacci-a", "Sacci")).toEqual({
      branch: "blog-draft-sacci-a",
    });
    expect(blogThreadDefaults(null, "Sacci").branch).toMatch(
      /^blog-draft-sacci-[0-9a-z]+$/,
    );
  });

  test("a Blog draft takes the project's runtime; another branch is a sandbox", () => {
    expect(blogThreadDefaults(null, "Sacci").runtime).toBeUndefined();
    expect(blogThreadDefaults("feature/x", "Sacci")).toEqual({
      branch: "feature/x",
      runtime: "sandbox",
    });
  });

  /** A thread Blog created and then refused would send the user to another
   *  draft right after they asked for this one. */
  test("every thread Blog creates is one Blog accepts", () => {
    for (const project of [fastPreviewProject, sandboxProject]) {
      for (const branch of [null, "blog-draft-sacci-a", "feature/x"]) {
        const created = blogThreadDefaults(branch, "Sacci");
        // The server stamps the project's default when none is asked for.
        const runtime = created.runtime ?? defaultThreadRuntime(project);
        expect(
          viewAcceptsThread("blog", thread(created.branch, runtime), project),
        ).toBe(true);
      }
    }
  });
});

describe("viewForThreadSwitch", () => {
  test("stays when the view can show the thread", () => {
    expect(
      viewForThreadSwitch(
        "blog",
        thread("blog-draft-a", "sandbox"),
        sandboxProject,
      ),
    ).toBeNull();
    expect(
      viewForThreadSwitch(
        "blog",
        thread("blog-draft-a", "cms"),
        fastPreviewProject,
      ),
    ).toBeNull();
    expect(
      viewForThreadSwitch("site", thread("sacci-a", "cms"), fastPreviewProject),
    ).toBeNull();
  });

  test("Blog sends a site draft in Fast Preview to the Site Editor", () => {
    expect(
      viewForThreadSwitch("blog", thread("sacci-a", "cms"), fastPreviewProject),
    ).toBe("site-editor");
  });

  test("a site view sends a Blog draft to Blog", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(
        viewForThreadSwitch(
          "site",
          thread("blog-draft-a", runtime),
          fastPreviewProject,
        ),
      ).toBe("blog");
    }
  });
});

describe("the draft select's list", () => {
  const releases = [
    { branch: "sacci-a", name: "Draft 1" },
    { branch: "blog-draft-sacci-b", name: "Blog Draft 1" },
    { branch: "sacci-c", name: "Draft 2" },
  ];

  test("each view lists its own drafts", () => {
    expect(
      draftsForView(releases, "blog", "blog-draft-sacci-b").map((r) => r.name),
    ).toEqual(["Blog Draft 1"]);
    expect(
      draftsForView(releases, "site", "sacci-a").map((r) => r.name),
    ).toEqual(["Draft 1", "Draft 2"]);
  });

  /** Filtering out the draft the user is on would make it "unlisted", and
   *  naming an unlisted draft adds a release the list already has: a rename
   *  that silently does nothing. */
  test("the current draft is listed whatever its kind", () => {
    expect(
      draftsForView(releases, "blog", "sacci-a").map((r) => r.name),
    ).toEqual(["Draft 1", "Blog Draft 1"]);
  });

  test("deleting the current draft moves to one of the same kind", () => {
    expect(siblingDraft(releases, "sacci-a", "site")?.branch).toBe("sacci-c");
    expect(
      siblingDraft(releases, "blog-draft-sacci-b", "blog"),
    ).toBeUndefined();
  });
});

describe("after publishing", () => {
  test("Blog on a CMS project opens a new Fast Preview thread on a fresh Blog draft", () => {
    const next = draftAfterPublish({
      viewKind: "blog",
      branch: "blog-draft-sacci-a",
      projectDefault: "cms",
      userLabel: "Sacci",
    });
    expect(next).toMatchObject({ kind: "new-thread", runtime: "cms" });
    expect(next.branch).toMatch(/^blog-draft-sacci-/);
  });

  test("Blog on a sandbox project moves its sandbox to a fresh Blog draft", () => {
    const next = draftAfterPublish({
      viewKind: "blog",
      branch: "blog-draft-sacci-a",
      projectDefault: "sandbox",
      userLabel: "Sacci",
    });
    expect(next.kind).toBe("repoint");
    expect(next.branch).toMatch(/^blog-draft-sacci-/);
  });

  test("Blog on an adopted branch also moves to a fresh Blog draft", () => {
    expect(
      draftAfterPublish({
        viewKind: "blog",
        branch: "feature/x",
        projectDefault: "cms",
        userLabel: "Sacci",
      }).branch,
    ).toMatch(/^blog-draft-/);
  });

  test("elsewhere, a CMS project opens a new Fast Preview thread", () => {
    const next = draftAfterPublish({
      viewKind: "site",
      branch: "sacci-a",
      projectDefault: "cms",
      userLabel: "Sacci",
    });
    expect(next).toMatchObject({ kind: "new-thread", runtime: "cms" });
    expect(next.branch).not.toMatch(/^blog-draft-/);
  });

  test("elsewhere, a sandbox project re-points to a fresh site draft", () => {
    const next = draftAfterPublish({
      viewKind: "site",
      branch: "sacci-a",
      projectDefault: "sandbox",
      userLabel: "Sacci",
    });
    expect(next.kind).toBe("repoint");
    expect(next.branch).toMatch(/^sacci-/);
  });

  test("the next draft keeps the published one's kind", () => {
    expect(nextDraftBranch("blog-draft-sacci-a", "Sacci")).toMatch(
      /^blog-draft-sacci-/,
    );
    expect(nextDraftBranch("sacci-a", "Sacci")).toMatch(/^sacci-/);
  });
});
