import { describe, expect, test } from "bun:test";
import { lastRunFailure } from "./run-failure";

const moved = (data: Record<string, unknown> | null) => ({
  action: "status_changed",
  data,
});

describe("lastRunFailure", () => {
  test("decodes the newest failure reason, stripping the wire prefix", () => {
    expect(
      lastRunFailure([
        moved({ to: "in_progress" }),
        moved({
          to: "todo",
          reason:
            "Error: GITHUB_NOT_AUTHENTICATED::GitHub installation_access_token failed: 422",
        }),
      ]),
    ).toEqual({
      code: "GITHUB_NOT_AUTHENTICATED",
      message: "GitHub installation_access_token failed: 422",
    });
  });

  test("a later move with no reason clears the failure", () => {
    expect(
      lastRunFailure([
        moved({ to: "todo", reason: "GITHUB_NOT_AUTHENTICATED::nope" }),
        moved({ to: "in_review" }),
      ]),
    ).toBeNull();
  });

  test("an unprefixed reason keeps its text and reports no code", () => {
    expect(lastRunFailure([moved({ to: "todo", reason: "boom" })])).toEqual({
      code: null,
      message: "boom",
    });
  });

  test("a pending retry is not a standing failure", () => {
    expect(
      lastRunFailure([moved({ to: "in_progress", retry: 1, reason: "boom" })]),
    ).toBeNull();
  });

  test("non-status entries and an empty timeline report nothing", () => {
    expect(lastRunFailure([{ action: "created", data: null }])).toBeNull();
    expect(lastRunFailure([])).toBeNull();
  });
});
