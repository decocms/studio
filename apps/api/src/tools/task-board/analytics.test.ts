import { describe, expect, test } from "bun:test";
import { TASK_BOARD_DELIVERY } from "./analytics";

describe("task board analytics input schema", () => {
  test("rejects a non-ISO from/to instead of crashing downstream", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({ from: "not-a-date" }).success,
    ).toBe(false);
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({ to: "2024-99-99" }).success,
    ).toBe(false);
  });

  test("accepts a valid ISO range, with or without an offset", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({
        from: "2024-01-01T00:00:00Z",
        to: "2024-01-31T00:00:00+02:00",
      }).success,
    ).toBe(true);
  });
});
