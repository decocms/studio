import { describe, expect, it } from "bun:test";
import { nextOrgFileOpenSearch } from "./org-file-open-context";

describe("nextOrgFileOpenSearch", () => {
  it("desktop: sets `main` and drops a stale `preview`", () => {
    expect(
      nextOrgFileOpenSearch({ preview: "home/old.md" }, "home/new.md", false),
    ).toEqual({ main: "library-file:home%2Fnew.md" });
  });

  it("mobile: sets `preview` and drops a stale `main`", () => {
    expect(
      nextOrgFileOpenSearch(
        { main: "library-file:home/old.md" },
        "home/new.md",
        true,
      ),
    ).toEqual({ preview: "home/new.md" });
  });

  it("preserves unrelated search params", () => {
    expect(
      nextOrgFileOpenSearch({ virtualmcpid: "abc" }, "home/new.md", true),
    ).toEqual({ virtualmcpid: "abc", preview: "home/new.md" });
  });
});
