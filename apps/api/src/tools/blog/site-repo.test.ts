import { describe, expect, test } from "bun:test";
import { resolveSiteBranch } from "./site-repo";

const NONE = { sandboxOnSiteRepo: false, flat: false };

describe("resolveSiteBranch", () => {
  test("an explicit branch wins over the caller's thread", () => {
    expect(
      resolveSiteBranch({
        ...NONE,
        explicit: " blog-aurora-1 ",
        threadBranch: "cms/edit",
      }),
    ).toBe("blog-aurora-1");
  });

  test("a sandbox key passed as the branch is refused", () => {
    expect(() =>
      resolveSiteBranch({
        ...NONE,
        explicit: "thread:abc",
        threadBranch: null,
      }),
    ).toThrow("sandbox key");
  });

  test("a CMS session's own branch, as it is", () => {
    expect(
      resolveSiteBranch({
        ...NONE,
        explicit: undefined,
        threadBranch: "cms/edit",
      }),
    ).toBe("cms/edit");
  });

  test("a sandbox on the site's repository writes where its checkout is", () => {
    expect(
      resolveSiteBranch({
        explicit: undefined,
        threadBranch: "thread:abc/repo_1",
        sandboxOnSiteRepo: true,
        flat: false,
      }),
    ).toBe("sandbox/thread-abc-repo_1");
    expect(
      resolveSiteBranch({
        explicit: undefined,
        threadBranch: "thread:abc",
        sandboxOnSiteRepo: true,
        flat: true,
      }),
    ).toBe("sandbox-thread-abc");
  });

  test("a sandbox on another repository, or none, has to name one", () => {
    expect(
      resolveSiteBranch({
        ...NONE,
        explicit: undefined,
        threadBranch: "thread:abc",
      }),
    ).toBeNull();
    expect(
      resolveSiteBranch({
        explicit: undefined,
        threadBranch: "ephemeral",
        sandboxOnSiteRepo: true,
        flat: false,
      }),
    ).toBeNull();
    expect(
      resolveSiteBranch({ ...NONE, explicit: "  ", threadBranch: null }),
    ).toBeNull();
  });
});
