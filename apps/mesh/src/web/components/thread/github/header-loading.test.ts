import { describe, expect, test } from "bun:test";
import { isPrStateActivelyLoading } from "./panel-state";

describe("isPrStateActivelyLoading", () => {
  test("does not treat disabled idle queries as active loading", () => {
    expect(
      isPrStateActivelyLoading({ isPending: true, fetchStatus: "idle" }),
    ).toBe(false);
  });

  test("treats pending fetching queries as active loading", () => {
    expect(
      isPrStateActivelyLoading({ isPending: true, fetchStatus: "fetching" }),
    ).toBe(true);
  });
});
