import { describe, expect, test } from "bun:test";
import * as panelState from "./panel-state";

describe("isPrStateActivelyLoading", () => {
  test("does not treat disabled idle queries as active loading", () => {
    const isPrStateActivelyLoading = panelState.isPrStateActivelyLoading as
      | ((query: { isPending: boolean; fetchStatus: string }) => boolean)
      | undefined;
    expect(typeof isPrStateActivelyLoading).toBe("function");
    expect(
      isPrStateActivelyLoading({ isPending: true, fetchStatus: "idle" }),
    ).toBe(false);
  });

  test("treats pending fetching queries as active loading", () => {
    const isPrStateActivelyLoading = panelState.isPrStateActivelyLoading as
      | ((query: { isPending: boolean; fetchStatus: string }) => boolean)
      | undefined;
    expect(typeof isPrStateActivelyLoading).toBe("function");
    expect(
      isPrStateActivelyLoading({ isPending: true, fetchStatus: "fetching" }),
    ).toBe(true);
  });
});
