import { describe, expect, it } from "bun:test";
import {
  coAuthorNameFromPrBody,
  lastPublishAttribution,
} from "./pr-attribution";

describe("coAuthorNameFromPrBody", () => {
  it("parses a trailer with an email", () => {
    expect(
      coAuthorNameFromPrBody(
        "Updated the hero.\n\nCo-authored-by: Ana Souza <ana@example.com>",
      ),
    ).toBe("Ana Souza");
  });

  it("parses a trailer without an email, case-insensitively", () => {
    expect(coAuthorNameFromPrBody("body\n\nco-authored-by: Ana")).toBe("Ana");
  });

  it("returns null for empty or trailer-less bodies", () => {
    expect(coAuthorNameFromPrBody(null)).toBeNull();
    expect(coAuthorNameFromPrBody("")).toBeNull();
    expect(coAuthorNameFromPrBody("Just a description")).toBeNull();
  });
});

describe("lastPublishAttribution", () => {
  it("prefers the trailer over the PR author", () => {
    expect(
      lastPublishAttribution({
        author: "studio-app[bot]",
        body: "x\n\nCo-authored-by: Ana <a@b.co>",
      }),
    ).toBe("Ana");
  });

  it("falls back to a human author login", () => {
    expect(lastPublishAttribution({ author: "gimenes", body: "" })).toBe(
      "gimenes",
    );
  });

  it("never renders a bot login", () => {
    expect(
      lastPublishAttribution({ author: "studio-app[bot]", body: "" }),
    ).toBeNull();
    expect(
      lastPublishAttribution({ author: "deploy-bot", body: "" }),
    ).toBeNull();
    expect(lastPublishAttribution({ author: "  ", body: "" })).toBeNull();
  });
});
