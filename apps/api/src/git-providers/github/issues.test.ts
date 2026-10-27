import { afterEach, describe, expect, test } from "bun:test";
import { GitProviderError } from "../types";
import { GithubIssueClient, mapIssue, type RawIssue } from "./issues";

const issue = (number: number, extra: Partial<RawIssue> = {}): RawIssue => ({
  number,
  html_url: `https://github.com/acme/site/issues/${number}`,
  title: `Issue ${number}`,
  state: "open",
  user: { login: "octo" },
  labels: [{ name: "bug" }],
  comments: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  ...extra,
});
const pullRequest = (number: number): RawIssue =>
  issue(number, { pull_request: { url: "x" } });

describe("mapIssue", () => {
  test("maps the neutral fields", () => {
    expect(mapIssue(issue(4))).toEqual({
      number: 4,
      url: "https://github.com/acme/site/issues/4",
      title: "Issue 4",
      body: "",
      state: "open",
      author: "octo",
      labels: ["bug"],
      comments: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    });
  });

  test("drops pull requests", () => {
    expect(mapIssue(pullRequest(5))).toBeNull();
  });

  test("reads string labels, skips empty ones, and a ghost author is null", () => {
    const mapped = mapIssue(
      issue(6, { labels: ["p1", { name: "" }, null], user: null }),
    );
    expect(mapped?.labels).toEqual(["p1"]);
    expect(mapped?.author).toBeNull();
  });
});

describe("GithubIssueClient", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stub(respond: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return calls;
  }

  const client = () =>
    new GithubIssueClient({
      repo: { provider: "github", host: "github.com", path: "acme/site" },
      tokenSource: {
        kind: "installation",
        get: async () => ({
          token: "t",
          kind: "installation",
          expiresAt: null,
        }),
      },
    });

  test("pages past pull requests to fill the limit, then stops", async () => {
    const pages: Record<string, RawIssue[]> = {
      "1": [
        ...Array.from({ length: 99 }, (_, i) => pullRequest(i + 100)),
        issue(1),
      ],
      "2": [issue(2), issue(3), issue(4)],
    };
    const calls = stub((url) => {
      const page = new URL(url).searchParams.get("page") ?? "";
      return Response.json(pages[page] ?? []);
    });
    const issues = await client().listOpen(3);
    expect(issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
  });

  test("an empty repository lists nothing in one call", async () => {
    const calls = stub(() => Response.json([]));
    expect(await client().listOpen(50)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("caps the walk when every row is a pull request", async () => {
    const calls = stub(() =>
      Response.json(Array.from({ length: 100 }, (_, i) => pullRequest(i))),
    );
    expect(await client().listOpen(10)).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  test("an unreadable repository throws instead of listing nothing", async () => {
    stub(() => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(client().listOpen(10)).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });

  test("read answers null for a missing, deleted, or pull request number", async () => {
    stub(() => new Response("", { status: 410 }));
    expect(await client().read(1)).toBeNull();
    stub(() => new Response("", { status: 404 }));
    expect(await client().read(1)).toBeNull();
    stub(() => Response.json(pullRequest(1)));
    expect(await client().read(1)).toBeNull();
  });

  test("close sends the reason; comment posts the body", async () => {
    const calls = stub(() => new Response("{}", { status: 200 }));
    await client().close(7, "not_planned");
    await client().comment(7, "Closing: fixed in #9");
    expect(calls[0]?.url).toEndWith("/repos/acme/site/issues/7");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
    expect(calls[1]?.url).toEndWith("/repos/acme/site/issues/7/comments");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      body: "Closing: fixed in #9",
    });
  });

  test("a refused close throws", async () => {
    stub(() => new Response('{"message":"Forbidden"}', { status: 403 }));
    await expect(client().close(7, "completed")).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });
});
