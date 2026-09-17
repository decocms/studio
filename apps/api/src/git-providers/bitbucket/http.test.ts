import { describe, expect, test } from "bun:test";
import { GitProviderError } from "../types";
import {
  assertBitbucketCloud,
  bbqString,
  bitbucketErrorMessage,
  bitbucketJson,
  bitbucketRetryAfterMs,
  nextPageNumber,
} from "./http";

describe("assertBitbucketCloud", () => {
  test("accepts bitbucket.org in any case", () => {
    expect(() => assertBitbucketCloud("bitbucket.org")).not.toThrow();
    expect(() => assertBitbucketCloud("Bitbucket.ORG")).not.toThrow();
  });
  test("refuses a self-hosted host, naming Data Center", () => {
    expect(() => assertBitbucketCloud("bitbucket.acme.com")).toThrow(
      /Data Center/,
    );
  });
});

describe("bitbucketErrorMessage", () => {
  test("flattens the REST error object", () => {
    expect(
      bitbucketErrorMessage(
        JSON.stringify({
          type: "error",
          error: { message: "Bad request", detail: "parents is not the tip" },
        }),
      ),
    ).toBe("Bad request; parents is not the tip");
  });
  test("flattens field errors too", () => {
    expect(
      bitbucketErrorMessage(
        JSON.stringify({
          error: {
            message: "Invalid",
            fields: { source: ["already an open pull request"] },
          },
        }),
      ),
    ).toContain("already an open pull request");
  });
  test("reads the OAuth shape", () => {
    expect(
      bitbucketErrorMessage(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "The code has expired",
        }),
      ),
    ).toBe("invalid_grant; The code has expired");
  });
  test("falls back to the raw text for a non-JSON body", () => {
    expect(bitbucketErrorMessage("<html>Gateway</html>")).toBe(
      "<html>Gateway</html>",
    );
  });
});

describe("bitbucketRetryAfterMs", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  test("Retry-After in seconds", () => {
    expect(
      bitbucketRetryAfterMs(new Headers({ "retry-after": "30" }), now),
    ).toBe(30_000);
  });
  test("Retry-After as an HTTP date", () => {
    expect(
      bitbucketRetryAfterMs(
        new Headers({ "retry-after": "Fri, 11 Sep 2026 12:00:10 GMT" }),
        now,
      ),
    ).toBe(10_000);
  });
  test("null when Bitbucket gave no hint", () => {
    expect(bitbucketRetryAfterMs(new Headers(), now)).toBeNull();
  });
});

describe("bitbucketJson", () => {
  test("parses a well-formed 2xx body", async () => {
    const res = new Response(JSON.stringify({ id: 1 }), { status: 200 });
    await expect(bitbucketJson(res, "get_repo")).resolves.toEqual({ id: 1 });
  });
  test("degrades a malformed 2xx body into a GitProviderError", async () => {
    const res = new Response("<html>Not JSON</html>", { status: 200 });
    await expect(bitbucketJson(res, "get_repo")).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });
});

describe("nextPageNumber", () => {
  test("reads the page the next url points at", () => {
    expect(
      nextPageNumber({
        next: "https://api.bitbucket.org/2.0/repositories?role=member&page=3",
      }),
    ).toBe(3);
  });
  test("null when the listing is exhausted or the url is odd", () => {
    expect(nextPageNumber({})).toBeNull();
    expect(nextPageNumber({ next: null })).toBeNull();
    expect(nextPageNumber({ next: "not a url" })).toBeNull();
    expect(nextPageNumber({ next: "https://x.y/z" })).toBeNull();
  });
});

describe("bbqString", () => {
  test("quotes and escapes for Bitbucket's query language", () => {
    expect(bbqString("feat/x")).toBe('"feat/x"');
    expect(bbqString('say "hi"')).toBe('"say \\"hi\\""');
    expect(bbqString("a\\b")).toBe('"a\\\\b"');
  });
});
