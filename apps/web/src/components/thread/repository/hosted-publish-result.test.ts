import { describe, expect, test } from "bun:test";
import { CmsRequestError } from "@/cms/cms-api";
import { parseHostedPublishResult } from "./hosted-publish-api";

describe("hosted publication acknowledgments", () => {
  test("a publication requires its confirmed revision", () => {
    expect(
      parseHostedPublishResult({
        result: "published",
        revision: "revision-1",
        previous: null,
        draftEmptied: true,
      }),
    ).toEqual({ result: "merged", sha: "revision-1" });
  });

  test("a confirmed no-op permits an empty production site", () => {
    for (const revision of [null, "revision-1"]) {
      expect(
        parseHostedPublishResult({ result: "up-to-date", revision }),
      ).toEqual({ result: "up-to-date" });
    }
  });

  test("malformed JSON objects cannot report success or up-to-date", () => {
    for (const value of [
      null,
      [],
      {},
      { error: "failed" },
      { result: "unknown", revision: "revision-1" },
      { result: "up-to-date" },
      { result: "up-to-date", revision: 1 },
      { result: "published", revision: "revision-1" },
      { result: "published", revision: "", previous: null },
      { result: "published", revision: null, previous: null },
    ]) {
      expect(() => parseHostedPublishResult(value)).toThrow(CmsRequestError);
    }
  });
});
