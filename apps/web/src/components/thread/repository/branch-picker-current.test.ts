import { describe, expect, it } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import { pickerCurrent } from "./branch-picker-current";

const named: Release = {
  branch: "main",
  name: "Summer",
  color: "blue",
  createdBy: "u",
  createdAt: "2026-01-01T00:00:00Z",
} as Release;

describe("pickerCurrent", () => {
  it("v7: the base branch is Production", () => {
    expect(
      pickerCurrent({ value: "main", baseBranch: "main", releases: [] }),
    ).toEqual({ isBase: true, current: undefined, unlisted: false });
  });

  it("hosted v8: the base branch holds the draft, shown as a draft entry", () => {
    expect(
      pickerCurrent({
        value: "main",
        baseBranch: "main",
        releases: [],
        baseIsDraft: true,
      }),
    ).toEqual({ isBase: false, current: undefined, unlisted: true });
  });

  it("hosted v8: a named base draft shows its name", () => {
    expect(
      pickerCurrent({
        value: "main",
        baseBranch: "main",
        releases: [named],
        baseIsDraft: true,
      }),
    ).toEqual({ isBase: false, current: named, unlisted: false });
  });

  it("a draft branch is the same either way", () => {
    for (const baseIsDraft of [false, true]) {
      expect(
        pickerCurrent({
          value: "ana-1",
          baseBranch: "main",
          releases: [],
          baseIsDraft,
        }),
      ).toEqual({ isBase: false, current: undefined, unlisted: true });
    }
  });
});
