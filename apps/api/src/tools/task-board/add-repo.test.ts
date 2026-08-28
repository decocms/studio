import { expect, test } from "bun:test";
import {
  MAX_SECONDARY_REPOS,
  parseRepoProbe,
  secondaryRepoCapExceeded,
} from "./add-repo";

// The probe is what decides "you can start reading files now", and the marker is
// the only part of it that can. The checkout directory is never empty: the pod
// stages `.deco` and mounts `org` into it before any clone starts.
test("the pod's own scaffolding is not a checkout", () => {
  // The exact probe output that shipped a 20-second "completed" task: no
  // marker, but two entries the old rule counted as a working tree.
  expect(parseRepoProbe(".deco\norg\n")).toEqual({
    cloned: false,
    listing: ".deco\norg",
  });
  expect(parseRepoProbe(".deco\n.git\norg\n")).toEqual({
    cloned: false,
    listing: ".deco\norg",
  });
});

test("the marker is the checkout, whatever else is in the directory", () => {
  expect(parseRepoProbe("__CLONED__\n.git\npackage.json\nsrc\n")).toEqual({
    cloned: true,
    listing: "package.json\nsrc",
  });
  // Scaffolding stays in the listing the model reads — it just no longer
  // decides anything.
  expect(
    parseRepoProbe("__CLONED__\n.deco\n.git\norg\npackage.json\n"),
  ).toEqual({
    cloned: true,
    listing: ".deco\norg\npackage.json",
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
