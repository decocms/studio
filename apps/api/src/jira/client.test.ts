import { describe, expect, it } from "bun:test";
import {
  jiraBodyToText,
  assertBoardId,
  normalizeSiteUrl,
  textToAdf,
} from "./client";

describe("normalizeSiteUrl", () => {
  it("accepts a bare host, a URL, and trailing slashes", () => {
    expect(normalizeSiteUrl("acme.atlassian.net")).toBe(
      "https://acme.atlassian.net",
    );
    expect(normalizeSiteUrl("https://acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net",
    );
    expect(normalizeSiteUrl(" http://acme.atlassian.net/jira ")).toBe(
      "https://acme.atlassian.net",
    );
  });

  it("rejects a dotless host", () => {
    expect(() => normalizeSiteUrl("acme")).toThrow("Invalid Jira site URL");
  });

  it("refuses any host outside Jira Cloud", () => {
    // This URL is fetched server-side with the tenant's credentials and the
    // response surfaces in `last_sync_error`, so a non-Jira host is an SSRF
    // read primitive for anyone holding org:manage.
    for (const host of [
      "169.254.169.254",
      "http://169.254.169.254/latest/meta-data/",
      "localhost:8080",
      "10.0.0.1",
      "internal.svc.cluster.local",
      "atlassian.net",
      "acme.atlassian.net.evil.com",
      "evil.com/acme.atlassian.net",
      "acme.atlassian.net@evil.com",
    ]) {
      expect(() => normalizeSiteUrl(host)).toThrow("Invalid Jira site URL");
    }
  });

  it("is case-insensitive about the host", () => {
    expect(normalizeSiteUrl("ACME.Atlassian.NET")).toBe(
      "https://acme.atlassian.net",
    );
  });
});

describe("assertBoardId", () => {
  it("passes numeric ids and rejects path injection", () => {
    expect(assertBoardId("42")).toBe("42");
    expect(() => assertBoardId("42/../secrets")).toThrow(
      "Invalid Jira board id",
    );
  });
});

describe("jiraBodyToText", () => {
  it("flattens paragraphs and hard breaks, drops marks", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "hardBreak" },
            { type: "text", text: "world" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    };
    expect(jiraBodyToText(adf)).toBe("Hello bold\nworld\n\nSecond");
  });

  it("converts v2-style string bodies (Agile API) to markdown", () => {
    expect(jiraBodyToText("h3. *Title*\nplain wiki text")).toBe(
      "### **Title**\nplain wiki text",
    );
  });

  it("returns empty on null and non-body values", () => {
    expect(jiraBodyToText(null)).toBe("");
    expect(jiraBodyToText(42)).toBe("");
  });
});

describe("textToAdf", () => {
  it("round-trips through jiraBodyToText, one paragraph per line", () => {
    expect(jiraBodyToText(textToAdf("Alice · via Studio:\nlooks good"))).toBe(
      "Alice · via Studio:\n\nlooks good",
    );
  });

  it("produces a valid empty paragraph for empty input", () => {
    expect(textToAdf("")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    });
  });
});
