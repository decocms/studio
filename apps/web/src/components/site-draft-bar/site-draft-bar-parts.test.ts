import { describe, expect, test } from "bun:test";
import {
  type SiteDraftBarInput,
  siteDraftBarParts,
} from "./site-draft-bar-parts";

const base: SiteDraftBarInput = {
  hasEntity: true,
  servingLocally: false,
  localPreview: false,
  tunnelUndecided: false,
  showsRepositoryActions: true,
  runtime: "cms",
};

describe("siteDraftBarParts", () => {
  test("a hosted v8 project: draft select and the content site's Publish", () => {
    expect(siteDraftBarParts(base)).toEqual({
      hidden: false,
      localFiles: false,
      draftSelect: true,
      publish: "cms",
    });
  });

  test("a code session publishes the code's way", () => {
    expect(siteDraftBarParts({ ...base, runtime: "sandbox" }).publish).toBe(
      "code",
    );
  });

  test("local edits are never published from here", () => {
    expect(
      siteDraftBarParts({ ...base, localPreview: true }).publish,
    ).toBeNull();
    expect(
      siteDraftBarParts({ ...base, tunnelUndecided: true }).publish,
    ).toBeNull();
    const served = siteDraftBarParts({ ...base, servingLocally: true });
    expect(served.publish).toBeNull();
    expect(served.localFiles).toBe(true);
  });

  test("a repository without Publish actions shows only the draft select", () => {
    const parts = siteDraftBarParts({ ...base, showsRepositoryActions: false });
    expect(parts.publish).toBeNull();
    expect(parts.draftSelect).toBe(true);
  });

  test("the account-less editor over `deco serve` shows its local files", () => {
    expect(
      siteDraftBarParts({ ...base, hasEntity: false, servingLocally: true }),
    ).toEqual({
      hidden: false,
      localFiles: true,
      draftSelect: false,
      publish: null,
    });
  });

  test("nothing to show without a project or a served site", () => {
    expect(siteDraftBarParts({ ...base, hasEntity: false }).hidden).toBe(true);
  });
});
