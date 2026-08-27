import { expect, test } from "bun:test";
import {
  MAX_SECONDARY_REPOS,
  parseRepoProbe,
  secondaryRepoCapExceeded,
} from "./add-repo";

// The probe is what decides "you can start reading files now". A HEAD ref lands
// before the checkout does on a lagging FS, so the marker alone must NOT count
// as ready — that false positive returns success on an empty directory.
test("the HEAD marker alone is not a checkout", () => {
  expect(parseRepoProbe("__CLONED__\n")).toEqual({
    cloned: false,
    listing: "",
  });
  expect(parseRepoProbe("__CLONED__\n.git\n")).toEqual({
    cloned: false,
    listing: "",
  });
});

test("working-tree entries are, and .git is not one of them", () => {
  expect(parseRepoProbe("__CLONED__\n.git\npackage.json\nsrc\n")).toEqual({
    cloned: true,
    listing: "package.json\nsrc",
  });
});

test("an empty directory is not cloned", () => {
  expect(parseRepoProbe("")).toEqual({ cloned: false, listing: "" });
});

test("a new repo is refused once the thread is at the secondary cap", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "acme", name: "one-more" }),
  ).toBe(true);
});

test("a repo below the cap is allowed", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS - 1 }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "acme", name: "one-more" }),
  ).toBe(false);
});

// Re-adding an existing repo is a storage no-op, so it must never be blocked.
test("a repo already checked out is let through at the cap, case-insensitively", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "ACME", name: "Repo-0" }),
  ).toBe(false);
});
