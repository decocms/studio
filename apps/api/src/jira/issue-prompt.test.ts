import { describe, expect, it } from "bun:test";
import {
  type IssueForPrompt,
  renderIssueForPrompt,
  renderIssuesForPrompt,
} from "./issue-prompt";

const base: IssueForPrompt = {
  id: "10012",
  key: "EX-12",
  url: "https://example.atlassian.net/browse/EX-12",
  summary: "Fix the checkout button",
  status: "Doing",
  reporter: null,
  assignee: null,
  description: "The button is green.\n\nMake it blue.",
  comments: [],
  attachments: [],
  links: [],
};

describe("renderIssueForPrompt", () => {
  it("leads with key, summary, status and link", () => {
    const text = renderIssueForPrompt(base);
    expect(text.startsWith("# EX-12: Fix the checkout button")).toBe(true);
    expect(text).toContain("Status: Doing");
    expect(text).toContain("Link: https://example.atlassian.net/browse/EX-12");
    expect(text).toContain("Make it blue.");
  });

  /** A rule's run reads here whether the card was handed forward or sent back. */
  it("says which move started the run, with the mover as a mention", () => {
    const text = renderIssueForPrompt(base, {
      toStatus: "Doing",
      fromStatus: "Client QA",
      movedBy: { accountId: "acc-ana", displayName: "Ana" },
      movedAt: "2026-09-29T14:31:00.000Z",
    });
    expect(text).toContain(
      "Status: Doing\nMoved into Doing from Client QA by @[Ana](accountid:acc-ana) at 2026-09-29T14:31:00.000Z — the move that started this run.",
    );
    expect(
      renderIssueForPrompt(base, {
        toStatus: "Doing",
        fromStatus: null,
        movedBy: null,
        movedAt: null,
      }),
    ).toContain("Moved into Doing — the move that started this run.");
    expect(renderIssueForPrompt(base)).not.toContain("Moved into");
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

  it("names the reporter and assignee in the form a run can mention", () => {
    const text = renderIssueForPrompt({
      ...base,
      reporter: "@[Thaís](accountid:712020:abc)",
      assignee: "@[Ana](accountid:557058:def)",
    });
    expect(text).toContain("Reporter: @[Thaís](accountid:712020:abc)");
    expect(text).toContain("Assignee: @[Ana](accountid:557058:def)");
    expect(renderIssueForPrompt(base)).not.toContain("Reporter:");
  });

  it("truncates a sprawling description rather than dropping it", () => {
    const text = renderIssueForPrompt({
      ...base,
      description: "x".repeat(20_000),
    });
    expect(text).toContain("[… truncated]");
    expect(text.length).toBeLessThan(13_000);
  });

  /** The comment budget is spent per-comment; landing on exactly zero on the
   *  OLDEST comment must not claim comments were omitted when none were. */
  it("does not claim omitted comments when the oldest one exhausts the budget", () => {
    const text = renderIssueForPrompt({
      ...base,
      comments: [
        {
          author: "Ana",
          created: "2026-09-01T10:00:00Z",
          body: "x".repeat(6_000),
        },
        {
          author: "Bo",
          created: "2026-09-01T11:00:00Z",
          body: "x".repeat(6_000),
        },
      ],
    });
    expect(text).toContain("**Ana**");
    expect(text).toContain("**Bo**");
    expect(text).not.toContain("omitted]");
  });

  /** A long thread of earlier handoffs must not push out the comment a run
   *  acts on — the latest verdict, or the client's rejection. */
  it("keeps the newest comments and drops the oldest when over budget", () => {
    const text = renderIssueForPrompt({
      ...base,
      comments: [
        {
          author: "Ana",
          created: "2026-09-01T10:00:00Z",
          body: "a".repeat(12_000),
        },
        {
          author: "Bo",
          created: "2026-09-01T11:00:00Z",
          body: "b".repeat(6_000),
        },
        {
          author: "Cy",
          created: "2026-09-01T12:00:00Z",
          body: "rejected: the modal opens behind the drawer",
        },
      ],
    });
    expect(text).toContain("rejected: the modal opens behind the drawer");
    expect(text).toContain("**Bo**");
    // Ana gets what budget is left, clipped, and nothing is dropped whole.
    expect(text).toContain("[… truncated]");
    expect(text).not.toContain("omitted]");
    expect(text.indexOf("**Ana**")).toBeLessThan(text.indexOf("**Cy**"));
  });

  it("says how many older comments were dropped whole", () => {
    const text = renderIssueForPrompt({
      ...base,
      comments: [
        { author: "Old", created: "2026-09-01T09:00:00Z", body: "stale" },
        {
          author: "Ana",
          created: "2026-09-01T10:00:00Z",
          body: "a".repeat(12_000),
        },
        { author: "Bo", created: "2026-09-01T11:00:00Z", body: "latest" },
      ],
    });
    expect(text).toContain("[… 1 older comment omitted]");
    expect(text).not.toContain("**Old**");
    expect(text).toContain("latest");
    expect(text.indexOf("omitted]")).toBeLessThan(text.indexOf("**Ana**"));
  });
});

describe("renderIssueForPrompt commentsBefore", () => {
  const comment = (author: string, body: string) => ({
    author,
    created: "2026-09-01T10:00:00Z",
    body,
  });
  // Six 5k comments: the 12k budget shows the newest two whole and a clipped
  // third, so a thread like this hides its oldest comments without paging.
  const thread: IssueForPrompt = {
    ...base,
    comments: ["A", "B", "C", "D", "E", "F"].map((name) =>
      comment(name, `${name}:${name.toLowerCase().repeat(5_000)}`),
    ),
  };

  it("names the commentsBefore that reaches the hidden comments", () => {
    const text = renderIssueForPrompt(thread);
    expect(text).toContain("[… 3 older comments omitted]");
    // D is shown clipped, so the next page ends after it and shows it whole.
    expect(text).toContain("`commentsBefore: 4`");
    expect(text).not.toContain("**A**");
  });

  it("pages back to the oldest comment, each read whole once", () => {
    const seenWhole = new Set<string>();
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const text = renderIssueForPrompt(thread, undefined, {
        commentsBefore: before,
      });
      for (const c of thread.comments) {
        if (text.includes(c.body)) seenWhole.add(c.author);
      }
      const next = text.match(/`commentsBefore: (\d+)`/);
      if (!next) break;
      const value = Number(next[1]);
      expect(before === undefined || value < before).toBe(true);
      before = value;
    }
    expect([...seenWhole].sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("labels a paged window and keeps the rest of the issue", () => {
    const text = renderIssueForPrompt(thread, undefined, { commentsBefore: 2 });
    expect(text).toContain("## Comments (1–2 of 6)");
    expect(text).toContain("**A**");
    expect(text).toContain("**B**");
    expect(text).not.toContain("**C**");
    expect(text).toContain("Make it blue.");
    expect(text).not.toContain("commentsBefore:");
  });

  it("does not offer a page that would not move past one oversized comment", () => {
    const text = renderIssueForPrompt({
      ...base,
      comments: [comment("Old", "short"), comment("Huge", "h".repeat(20_000))],
    });
    expect(text).toContain("[… 1 older comment omitted]");
    expect(text).toContain("`commentsBefore: 1`");
  });

  it("clamps a commentsBefore past the end of the thread", () => {
    const text = renderIssueForPrompt(
      { ...base, comments: [comment("Only", "one")] },
      undefined,
      { commentsBefore: 50 },
    );
    expect(text).toContain("## Comments\n");
    expect(text).toContain("**Only**");
  });
});

describe("renderIssuesForPrompt", () => {
  it("digests each issue with its links and says how to read one in full", () => {
    const out = renderIssuesForPrompt([
      { ...base, key: "EX-1", summary: "First", status: "Done" },
      {
        ...base,
        key: "EX-2",
        summary: "Second",
        links: [{ title: "PR", url: "https://example.com/pr/2" }],
        description: "a body that must not be here",
      },
    ]);
    expect(out).toContain("# 2 Jira issues");
    expect(out).toContain("## EX-1: First\nStatus: Done");
    expect(out).toContain("## EX-2: Second");
    expect(out).toContain("- [PR](https://example.com/pr/2)");
    expect(out).not.toContain("a body that must not be here");
    expect(out).toContain("`JIRA_ISSUE_GET` with a key");
  });
});
