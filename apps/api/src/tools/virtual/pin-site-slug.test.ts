import { describe, expect, it } from "bun:test";
import { pinnedSiteSlugOnRename } from "./pin-site-slug";

describe("pinnedSiteSlugOnRename", () => {
  it("pins the outgoing title when a slugless agent is renamed", () => {
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: "Acme Store",
        currentTitle: "acmestore",
        currentSiteSlug: null,
      }),
    ).toBe("acmestore");
  });

  it("normalizes the outgoing title it pins", () => {
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: "renamed",
        currentTitle: "  AcmeStore  ",
        currentSiteSlug: undefined,
      }),
    ).toBe("acmestore");
  });

  it("leaves an already-stamped slug alone", () => {
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: "Acme Store",
        currentTitle: "acmestore",
        currentSiteSlug: "some-other-site",
      }),
    ).toBeNull();
  });

  it("does nothing when the title is absent or unchanged", () => {
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: undefined,
        currentTitle: "acmestore",
        currentSiteSlug: null,
      }),
    ).toBeNull();
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: "acmestore",
        currentTitle: "acmestore",
        currentSiteSlug: null,
      }),
    ).toBeNull();
  });

  it("skips titles that were never usable as a slug", () => {
    for (const currentTitle of [
      "My Cool Agent",
      "-leading-hyphen",
      "under_score",
      "a".repeat(61),
      "",
      "   ",
      null,
    ]) {
      expect(
        pinnedSiteSlugOnRename({
          nextTitle: "renamed",
          currentTitle,
          currentSiteSlug: null,
        }),
      ).toBeNull();
    }
  });

  it("treats a blank stamped slug as unset", () => {
    expect(
      pinnedSiteSlugOnRename({
        nextTitle: "renamed",
        currentTitle: "acmestore",
        currentSiteSlug: "   ",
      }),
    ).toBe("acmestore");
  });
});
