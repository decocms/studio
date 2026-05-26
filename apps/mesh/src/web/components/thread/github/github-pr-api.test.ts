import { describe, expect, test } from "bun:test";
import {
  extractToolJson,
  pullNumberFromUrl,
  pullRequestFromToolText,
} from "./extract-tool-json.ts";
import { parseCreatedPullRequestResult } from "./github-pr-api.ts";

describe("extract-tool-json", () => {
  test("prefers content text when structuredContent is an empty object", () => {
    const payload = [{ number: 9, html_url: "https://github.com/o/r/pull/9" }];
    const parsed = extractToolJson<unknown[]>({
      structuredContent: {},
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });
    expect(parsed).toEqual(payload);
  });

  test("pullNumberFromUrl parses GitHub PR links", () => {
    expect(
      pullNumberFromUrl("https://github.com/deco-cx/deco/pull/12345"),
    ).toBe(12345);
  });

  test("pullRequestFromToolText parses plain-text tool payloads", () => {
    expect(
      pullRequestFromToolText({
        content: [
          {
            type: "text",
            text: "Pull request opened: https://github.com/o/r/pull/7",
          },
        ],
      }),
    ).toEqual({
      number: 7,
      htmlUrl: "https://github.com/o/r/pull/7",
    });
  });
});

describe("parseCreatedPullRequestResult", () => {
  test("parses github-mcp-server MinimalResponse { id, url }", () => {
    const pr = parseCreatedPullRequestResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "2847461234",
            url: "https://github.com/deco-cx/deco/pull/42",
          }),
        },
      ],
    });

    expect(pr).toEqual({
      number: 42,
      htmlUrl: "https://github.com/deco-cx/deco/pull/42",
    });
  });

  test("parses legacy { number, html_url } payloads", () => {
    const pr = parseCreatedPullRequestResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            number: 3,
            html_url: "https://github.com/o/r/pull/3",
          }),
        },
      ],
    });

    expect(pr).toEqual({
      number: 3,
      htmlUrl: "https://github.com/o/r/pull/3",
    });
  });
});
