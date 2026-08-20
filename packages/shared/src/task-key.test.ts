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
