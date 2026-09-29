import { describe, expect, test } from "bun:test";
import { scopedProjectLacksSource } from "./nav-destinations-classic";

/** The gate that drops Home, Reports and Tasks from the classic sidebar. It
 *  hides three of the five rows, and the other two are org-only, so getting it
 *  wrong inside a project leaves a sidebar with no destinations at all. */
describe("scopedProjectLacksSource", () => {
  const repo = { metadata: { repository: { url: "https://github.com/a/b" } } };

  test("fails open above a project, and before one resolves", () => {
    expect(scopedProjectLacksSource(null, null)).toBe(false);
    expect(scopedProjectLacksSource("vir_1", null)).toBe(false);
  });

  test("a project with a repository has source", () => {
    expect(scopedProjectLacksSource("vir_1", repo)).toBe(false);
  });

  /** The projects flow creates these: a real project that has not been given a
   *  repository yet. It keeps its rows. */
  test("a project made in the projects flow has its rows without a repository", () => {
    expect(
      scopedProjectLacksSource("vir_1", {
        metadata: { project: { storeUrl: null } },
      }),
    ).toBe(false);
  });

  /** What the gate was written for, and still holds: a chat-only agent has no
   *  overview, board or report to reach. */
  test("a sourceless agent that predates projects still loses them", () => {
    expect(scopedProjectLacksSource("vir_1", { metadata: {} })).toBe(true);
    expect(scopedProjectLacksSource("vir_1", { metadata: null })).toBe(true);
  });
});
