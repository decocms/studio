import { describe, expect, it } from "bun:test";
import { matchesBranchSearch } from "./use-branches";

/**
 * This predicate must agree with GitHub's `refs(query:)`, which the picker's
 * repo list now delegates to — if cmdk hid a row the server matched, the search
 * would look broken in exactly the way the server-side search was meant to fix.
 */
describe("matchesBranchSearch", () => {
  it("matches a substring in the middle of the ref name", () => {
    expect(
      matchesBranchSearch("claude/fastpreview-upstream-authority", "upstream"),
    ).toBe(true);
  });

  it("matches across the path separator, not just the last segment", () => {
    expect(matchesBranchSearch("claude/admiring-hopper", "claude/adm")).toBe(
      true,
    );
  });

  it("ignores case on both sides", () => {
    expect(matchesBranchSearch("Fix-UI-Tables", "ui-tables")).toBe(true);
    expect(matchesBranchSearch("fix-ui-tables", "UI-TABLES")).toBe(true);
  });

  it("ignores surrounding whitespace in the search term", () => {
    expect(matchesBranchSearch("fixes/streaming", "  streaming ")).toBe(true);
  });

  it("does not match non-contiguous characters, unlike a fuzzy scorer", () => {
    expect(matchesBranchSearch("fix-workspace-wallet", "fix wallet")).toBe(
      false,
    );
  });

  it("rejects a term the name does not contain", () => {
    expect(matchesBranchSearch("main", "upstream")).toBe(false);
  });

  it("matches everything when the term is empty or blank", () => {
    expect(matchesBranchSearch("any-branch", "")).toBe(true);
    expect(matchesBranchSearch("any-branch", "   ")).toBe(true);
  });
});
