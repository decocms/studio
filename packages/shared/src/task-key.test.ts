import { describe, expect, test } from "bun:test";
import { taskKey, taskKeyPrefix } from "./task-key";

describe("taskKeyPrefix", () => {
  test("takes the slug's first four letters", () => {
    expect(taskKeyPrefix("deco")).toBe("DECO");
    expect(taskKeyPrefix("rafaelvalls-local")).toBe("RAFA");
  });

  test("skips digits and separators", () => {
    expect(taskKeyPrefix("acme-2-co")).toBe("ACME");
    expect(taskKeyPrefix("a-b-c-d-e")).toBe("ABCD");
  });

  test("a short slug keeps whatever it has", () => {
    expect(taskKeyPrefix("ab")).toBe("AB");
  });

  test("a letterless slug falls back", () => {
    expect(taskKeyPrefix("123-456")).toBe("TASK");
  });
});

describe("taskKey", () => {
  test("pads to two digits and grows past them", () => {
    expect(taskKey("deco", 1)).toBe("DECO-01");
    expect(taskKey("deco", 42)).toBe("DECO-42");
    expect(taskKey("deco", 1234)).toBe("DECO-1234");
  });

  test("a card from before the backfill has no key", () => {
    expect(taskKey("deco", null)).toBeNull();
    expect(taskKey("deco", undefined)).toBeNull();
  });
});

/**
 * A synced card wears the tracker's key because that is the name it already
 * has — in the issue, the branch, the PR title and everything anyone says
 * about it. The Studio sequence is untouched underneath; it just stops being
 * the thing on screen.
 */
describe("taskKey with a tracker key", () => {
  test("shows the tracker's key instead of the Studio one", () => {
    expect(taskKey("osklen", 320, "OS-333")).toBe("OS-333");
  });

  test("keeps the Studio key for a card Studio owns", () => {
    expect(taskKey("osklen", 320, null)).toBe("OSKL-320");
    expect(taskKey("osklen", 320, undefined)).toBe("OSKL-320");
  });

  test("treats a blank tracker key as absent rather than showing nothing", () => {
    expect(taskKey("osklen", 320, "")).toBe("OSKL-320");
    expect(taskKey("osklen", 320, "   ")).toBe("OSKL-320");
  });

  test("shows a tracker key even for a card from before the backfill", () => {
    expect(taskKey("osklen", null, "OS-333")).toBe("OS-333");
    expect(taskKey("osklen", null, null)).toBe(null);
  });
});
