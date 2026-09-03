import { describe, expect, it } from "bun:test";
import { type IssueForPrompt, renderIssueForPrompt } from "./issue-prompt";

const base: IssueForPrompt = {
  key: "EX-12",
  url: "https://example.atlassian.net/browse/EX-12",
  summary: "Fix the checkout button",
  status: "Doing",
  description: "The button is green.\n\nMake it blue.",
  comments: [],
  attachments: [],
};

describe("renderIssueForPrompt", () => {
  it("leads with key, summary, status and link", () => {
    const text = renderIssueForPrompt(base);
    expect(text.startsWith("# EX-12: Fix the checkout button")).toBe(true);
    expect(text).toContain("Status: Doing");
    expect(text).toContain("Link: https://example.atlassian.net/browse/EX-12");
    expect(text).toContain("Make it blue.");
  });

  /** The id is what the download tool takes, so it has to be on the page. */
  it("lists attachments by id and says how to fetch one", () => {
    const text = renderIssueForPrompt({
      ...base,
      attachments: [{ id: "10042", filename: "mock.png", size: 20480 }],
    });
    expect(text).toContain("mock.png (20 KB) — attachment id `10042`");
    expect(text).toContain("JIRA_ATTACHMENT_DOWNLOAD");
  });

  it("omits the attachment and comment sections when there is nothing", () => {
    const text = renderIssueForPrompt(base);
    expect(text).not.toContain("## Attachments");
    expect(text).not.toContain("## Comments");
  });

  it("renders comments in order with their author", () => {
    const text = renderIssueForPrompt({
      ...base,
      comments: [
        { author: "Ana", created: "2026-09-01T10:00:00Z", body: "first" },
        { author: "Bo", created: "2026-09-01T11:00:00Z", body: "second" },
      ],
    });
    expect(text.indexOf("**Ana**")).toBeLessThan(text.indexOf("**Bo**"));
  });

  it("truncates a sprawling description rather than dropping it", () => {
    const text = renderIssueForPrompt({
      ...base,
      description: "x".repeat(20_000),
    });
    expect(text).toContain("[… truncated]");
    expect(text.length).toBeLessThan(13_000);
  });
});
