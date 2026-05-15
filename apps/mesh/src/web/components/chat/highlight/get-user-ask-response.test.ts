import { describe, expect, test } from "bun:test";
import { getUserAskResponse } from "./get-user-ask-response";

describe("getUserAskResponse", () => {
  test("returns empty string for undefined value", () => {
    expect(getUserAskResponse(undefined)).toBe("");
  });

  test("returns response for text/confirm shape", () => {
    expect(getUserAskResponse({ response: "hello" })).toBe("hello");
    expect(getUserAskResponse({ response: "" })).toBe("");
  });

  test("returns option when a predefined choice is selected", () => {
    expect(getUserAskResponse({ option: "Option 1", draft: "" })).toBe(
      "Option 1",
    );
  });

  test("prefers option over draft when both are present", () => {
    expect(getUserAskResponse({ option: "Option 1", draft: "foo" })).toBe(
      "Option 1",
    );
  });

  test("returns draft when option is null", () => {
    expect(getUserAskResponse({ option: null, draft: "foo" })).toBe("foo");
  });

  test("returns empty string when option is null and draft is empty", () => {
    expect(getUserAskResponse({ option: null, draft: "" })).toBe("");
  });
});
