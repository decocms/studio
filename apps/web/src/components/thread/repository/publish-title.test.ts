import { describe, expect, test } from "bun:test";
import { publishTitle } from "./publish-title";

const t = (key: string, vars?: { count: number }) =>
  vars ? `${key}:${vars.count}` : key;

describe("publishTitle", () => {
  test("v7: publishing to main or master says in production, as before", () => {
    expect(publishTitle(1, "main", false, t)).toBe(
      "thread.publishPopover.publishOneInProduction",
    );
    expect(publishTitle(3, " Master ", false, t)).toBe(
      "thread.publishPopover.publishCountInProduction:3",
    );
    expect(publishTitle(2, "staging", false, t)).toBe(
      "thread.publishPopover.publishCount:2",
    );
    expect(publishTitle(0, "main", false, t)).toBe(
      "thread.publishPopover.publish",
    );
  });

  test("v8: never says in production", () => {
    expect(publishTitle(1, "main", true, t)).toBe(
      "thread.publishPopover.publishOne",
    );
    expect(publishTitle(3, "main", true, t)).toBe(
      "thread.publishPopover.publishCount:3",
    );
    expect(publishTitle(0, "main", true, t)).toBe(
      "thread.publishPopover.publish",
    );
  });
});
