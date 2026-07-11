import { describe, expect, test } from "bun:test";
import { nextDrift } from "./version-check-dialog";

const NONE = { version: null, count: 0 };

describe("nextDrift", () => {
  test("resets when server version matches client", () => {
    expect(nextDrift({ version: "4.0.0", count: 1 }, "4.1.0", "4.1.0")).toEqual(
      NONE,
    );
  });

  test("resets when server version is missing", () => {
    expect(
      nextDrift({ version: "4.0.0", count: 1 }, undefined, "4.0.0"),
    ).toEqual(NONE);
  });

  test("first drift starts a count of 1", () => {
    expect(nextDrift(NONE, "4.1.0", "4.0.0")).toEqual({
      version: "4.1.0",
      count: 1,
    });
  });

  test("same drift version again increments the count", () => {
    const first = nextDrift(NONE, "4.1.0", "4.0.0");
    expect(nextDrift(first, "4.1.0", "4.0.0")).toEqual({
      version: "4.1.0",
      count: 2,
    });
  });

  test("a different drift version restarts the count at 1", () => {
    const first = nextDrift(NONE, "4.1.0", "4.0.0");
    expect(nextDrift(first, "4.2.0", "4.0.0")).toEqual({
      version: "4.2.0",
      count: 1,
    });
  });
});
