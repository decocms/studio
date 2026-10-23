import { describe, expect, test } from "bun:test";
import {
  DATED_RELEASE_NOTE,
  datedReleaseNote,
  MADE_CURRENT_PREFIX,
  MADE_CURRENT_PREFIXES,
  UNKNOWN_RELEASE_NOTE,
  UNKNOWN_RELEASE_NOTES,
} from "./release-notes";

describe("release notes", () => {
  test("the note the server writes is the one the screen reads", () => {
    expect(datedReleaseNote("2026-10-14 13:05 UTC")).toMatch(
      DATED_RELEASE_NOTE,
    );
    expect("version from 2026-10-14 13:05 UTC").toMatch(DATED_RELEASE_NOTE);
    expect(UNKNOWN_RELEASE_NOTES.has(UNKNOWN_RELEASE_NOTE)).toBe(true);
    expect(MADE_CURRENT_PREFIXES[0]).toBe(MADE_CURRENT_PREFIX);
  });

  test("the words stay those already written in past notes", () => {
    expect([...MADE_CURRENT_PREFIXES]).toEqual(["Made current: ", "Reapply: "]);
    expect(datedReleaseNote("2026-10-14 13:05 UTC")).toBe(
      "release from 2026-10-14 13:05 UTC",
    );
  });
});
