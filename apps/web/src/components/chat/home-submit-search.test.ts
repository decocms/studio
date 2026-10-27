import { describe, expect, test } from "bun:test";
import { AUTOSEND_QUERY_VALUE } from "@/lib/autosend";
import { homeSubmitSearch } from "./home-submit-search";

describe("homeSubmitSearch", () => {
  test("a chat message opens the chat beside the page", () => {
    expect(homeSubmitSearch(false)).toEqual({
      autosend: AUTOSEND_QUERY_VALUE,
      sidepanel: true,
    });
  });

  test("a task hands off to the chat alone", () => {
    expect(homeSubmitSearch(true)).toEqual({
      autosend: AUTOSEND_QUERY_VALUE,
      sidepanel: true,
      mainpanel: false,
    });
  });
});
