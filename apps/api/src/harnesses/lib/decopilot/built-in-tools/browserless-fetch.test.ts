import { describe, expect, it } from "bun:test";
import { browserlessFetchErrorMessage } from "./browserless-fetch";
import { BROWSERLESS_FETCH_TIMEOUT_MS } from "./constants";

describe("browserlessFetchErrorMessage", () => {
  it("names the timeout when the bounding signal fired", () => {
    const err = new Error("The operation was aborted");
    err.name = "TimeoutError";

    expect(browserlessFetchErrorMessage("Browserless content fetch", err)).toBe(
      `Browserless content fetch timed out after ${BROWSERLESS_FETCH_TIMEOUT_MS}ms`,
    );
  });

  it("reports other transport failures with their message", () => {
    expect(
      browserlessFetchErrorMessage(
        "Browserless function call",
        new Error("ECONNREFUSED"),
      ),
    ).toBe("Browserless function call failed: ECONNREFUSED");
  });

  it("stringifies non-Error rejections", () => {
    expect(
      browserlessFetchErrorMessage("Browserless content fetch", "nope"),
    ).toBe("Browserless content fetch failed: nope");
  });
});
