import { describe, expect, it } from "bun:test";
import {
  countGitDiffFiles,
  decodeGithubFileContent,
  fetchGithubPrDiff,
} from "./github-pr-diff.ts";

describe("github-pr-diff", () => {
  it("countGitDiffFiles returns zero for empty diff", () => {
    expect(countGitDiffFiles(null)).toBe(0);
    expect(countGitDiffFiles({ diffs: {} })).toBe(0);
  });

  it("countGitDiffFiles counts diff entries", () => {
    expect(
      countGitDiffFiles({
        diffs: {
          "a.ts": { from: "a", to: "b" },
          "b.ts": { from: null, to: "new" },
        },
      }),
    ).toBe(2);
  });

  it("decodeGithubFileContent parses JSON string payloads", () => {
    const result = decodeGithubFileContent({
      content: [
        {
          type: "resource",
          resource: { text: JSON.stringify("hello") },
        },
      ],
    });
    expect(result).toBe("hello");
  });

  it("decodeGithubFileContent parses object content field", () => {
    const result = decodeGithubFileContent({
      content: [
        {
          type: "resource",
          resource: { text: JSON.stringify({ content: "file body" }) },
        },
      ],
    });
    expect(result).toBe("file body");
  });

  it("decodeGithubFileContent returns null for tool errors", () => {
    expect(decodeGithubFileContent({ isError: true })).toBeNull();
  });

  it("fetchGithubPrDiff reads a renamed file's old content from its previous path", async () => {
    const fileContentByPath: Record<string, string> = {
      "old.ts": "old content",
      "new.ts": "new content",
    };
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        calls.push(req);
        if (req.name === "pull_request_read") {
          return {
            structuredContent: [
              {
                filename: "new.ts",
                previous_filename: "old.ts",
                status: "renamed",
                additions: 1,
                deletions: 1,
                changes: 2,
              },
            ],
          };
        }
        const path = req.arguments.path as string;
        return {
          content: [
            {
              type: "resource",
              resource: {
                text: JSON.stringify(fileContentByPath[path] ?? null),
              },
            },
          ],
        };
      },
    };

    const result = await fetchGithubPrDiff(client, {
      owner: "acme",
      repo: "widgets",
      pullNumber: 1,
      base: "main",
      headSha: "headsha",
    });

    expect(result.diffs["new.ts"]).toEqual({
      from: "old content",
      to: "new content",
    });
    const fromCall = calls.find(
      (c) => c.name === "get_file_contents" && c.arguments.ref === "main",
    );
    expect(fromCall?.arguments.path).toBe("old.ts");
  });

  it("fetchGithubPrDiff throws instead of silently returning an empty diff when get_files errors", async () => {
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        if (req.name === "pull_request_read") {
          return {
            isError: true,
            content: [{ type: "text", text: "403 Resource not accessible" }],
          };
        }
        throw new Error("should not fetch file contents");
      },
    };

    await expect(
      fetchGithubPrDiff(client, {
        owner: "acme",
        repo: "widgets",
        pullNumber: 1,
        base: "main",
        headSha: "headsha",
      }),
    ).rejects.toThrow("403 Resource not accessible");
  });

  it("fetchGithubPrDiff paginates past the first 100 changed files", async () => {
    const totalFiles = 150;
    const client = {
      callTool: async (req: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        if (req.name === "pull_request_read") {
          const page = Number(req.arguments.page ?? 1);
          const perPage = Number(req.arguments.perPage ?? 100);
          const start = (page - 1) * perPage;
          const pageFiles = Array.from(
            { length: Math.max(0, Math.min(perPage, totalFiles - start)) },
            (_, i) => ({
              filename: `file-${start + i}.ts`,
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
            }),
          );
          return { structuredContent: pageFiles };
        }
        return {
          content: [
            {
              type: "resource",
              resource: { text: JSON.stringify("content") },
            },
          ],
        };
      },
    };

    const result = await fetchGithubPrDiff(client, {
      owner: "acme",
      repo: "widgets",
      pullNumber: 1,
      base: "main",
      headSha: "headsha",
    });

    expect(Object.keys(result.diffs)).toHaveLength(totalFiles);
  });
});
