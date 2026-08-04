import { expect, test } from "bun:test";
import { parseRepoProbe } from "./add-repo";

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
