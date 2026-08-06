import { describe, expect, test } from "bun:test";
import {
  extractToolJson,
  pullNumberFromUrl,
  pullRequestFromToolText,
} from "./extract-tool-json.ts";
import {
  openPullRequestForBranch,
  parseCreatedPullRequestResult,
  PULL_REQUEST_ALREADY_EXISTS_MESSAGE,
  squashMergePullRequest,
} from "./github-pr-api.ts";

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

describe("squashMergePullRequest", () => {
  test("requires merged === true in response", async () => {
    const client = {
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ merged: false }) }],
      }),
    };

    await expect(
      squashMergePullRequest(client, {
        owner: "o",
        repo: "r",
        pullNumber: 1,
      }),
    ).rejects.toThrow("Failed to merge pull request");
  });

  test("appends co-author to squash commit message", async () => {
    let args: Record<string, unknown> | undefined;
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        args = req.arguments;
        return {
          content: [{ type: "text", text: JSON.stringify({ merged: true }) }],
        };
      },
    };

    await squashMergePullRequest(client, {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      commitMessage: "feat: ship it",
      coAuthor: { userName: "Jane Doe", userEmail: "jane@example.com" },
    });

    expect(args?.commit_message).toBe(
      "feat: ship it\n\nCo-authored-by: Jane Doe <jane@example.com>",
    );
  });
});

describe("openPullRequestForBranch", () => {
  test("creates a PR and never calls list_pull_requests", async () => {
    const names: string[] = [];
    let args: Record<string, unknown> | undefined;
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        names.push(req.name);
        args = req.arguments;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                url: "https://github.com/o/r/pull/2",
              }),
            },
          ],
        };
      },
    };

    const pr = await openPullRequestForBranch(client, {
      owner: "o",
      repo: "r",
      branch: "feat/x",
      title: "feat: x",
      base: "main",
      coAuthor: { userName: "Jane Doe", userEmail: "jane@example.com" },
    });

    expect(pr).toEqual({ number: 2, htmlUrl: "https://github.com/o/r/pull/2" });
    // No co-author-only body should be created.
    expect(args?.body).toBeUndefined();
    expect(names).toEqual(["create_pull_request"]);
    expect(names).not.toContain("list_pull_requests");
  });

  test("reuses an existing PR without listing or creating", async () => {
    const names: string[] = [];
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        names.push(req.name);
        return { content: [{ type: "text", text: "{}" }] };
      },
    };

    const pr = await openPullRequestForBranch(client, {
      owner: "o",
      repo: "r",
      branch: "feat/x",
      title: "feat: x",
      body: "already open",
      base: "main",
      existing: { number: 9, htmlUrl: "https://github.com/o/r/pull/9" },
      coAuthor: { userName: "Jane Doe", userEmail: "jane@example.com" },
    });

    expect(pr).toEqual({ number: 9, htmlUrl: "https://github.com/o/r/pull/9" });
    // Only a best-effort co-author body update — never list/create.
    expect(names).not.toContain("list_pull_requests");
    expect(names).not.toContain("create_pull_request");
  });

  test("surfaces a retry message when create reports a duplicate PR", async () => {
    const names: string[] = [];
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        names.push(req.name);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "A pull request already exists for o:feat/x.",
            },
          ],
        };
      },
    };

    await expect(
      openPullRequestForBranch(client, {
        owner: "o",
        repo: "r",
        branch: "feat/x",
        title: "feat: x",
        base: "main",
      }),
    ).rejects.toThrow(PULL_REQUEST_ALREADY_EXISTS_MESSAGE);
    // We must NOT fall back to list_pull_requests to recover the PR.
    expect(names).not.toContain("list_pull_requests");
  });
});
