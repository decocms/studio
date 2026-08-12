import { describe, expect, it } from "bun:test";
import {
  capturePrForRun,
  handTaskToHuman,
  isPrCreateBashCommand,
  isPrCreateMcpTool,
  resolveAdvanceTargets,
} from "./run-reactions";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { TaskBoardItem } from "@/storage/types";

type LinkPrCall = {
  taskBoardItemId: string;
  organizationId: string;
  url: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  connectionId?: string | null;
};

/** In-memory ctx: records linkPr calls, resolves the thread link from `linked`. */
function makeCtx(opts: {
  orgId?: string;
  metadataItemId?: string;
  linked?: string[];
}) {
  const linkPrCalls: LinkPrCall[] = [];
  const ctx = {
    organization: opts.orgId ? { id: opts.orgId } : undefined,
    metadata: opts.metadataItemId
      ? { runMetadata: { taskBoardItemId: opts.metadataItemId } }
      : {},
    storage: {
      taskBoard: {
        linkPr: async (p: LinkPrCall) => {
          linkPrCalls.push(p);
        },
        linkedTaskIds: async () => opts.linked ?? [],
      },
    },
  } as never;
  return { ctx, linkPrCalls };
}

const MCP_RESULT = {
  structuredContent: { id: 1, url: "https://github.com/acme/site/pull/42" },
};
const BASH_OUTPUT = {
  exitCode: 0,
  stdout: "https://github.com/acme/site/pull/42\n",
};

describe("capturePrForRun", () => {
  it("links the PR to the metadata-resolved task (the subagent-shares-ctx path)", async () => {
    const { ctx, linkPrCalls } = makeCtx({
      orgId: "org-1",
      metadataItemId: "item-1",
    });
    await capturePrForRun(ctx, MCP_RESULT, "conn-9", "thr-x");
    expect(linkPrCalls).toEqual([
      {
        taskBoardItemId: "item-1",
        organizationId: "org-1",
        url: "https://github.com/acme/site/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "site",
        connectionId: "conn-9",
      },
    ]);
  });

  it("falls back to the thread link when the run carries no metadata", async () => {
    const { ctx, linkPrCalls } = makeCtx({
      orgId: "org-1",
      linked: ["item-2", "item-3"],
    });
    await capturePrForRun(ctx, BASH_OUTPUT, null, "thr-x");
    expect(linkPrCalls.map((c) => c.taskBoardItemId)).toEqual([
      "item-2",
      "item-3",
    ]);
    expect(linkPrCalls[0]?.connectionId).toBeNull();
    expect(linkPrCalls[0]?.prNumber).toBe(42);
  });

  it("captures a PR from bash stdout (main-agent gh/curl path)", async () => {
    const { ctx, linkPrCalls } = makeCtx({
      orgId: "org-1",
      metadataItemId: "item-1",
    });
    await capturePrForRun(ctx, BASH_OUTPUT, null, "thr-x");
    expect(linkPrCalls).toHaveLength(1);
    expect(linkPrCalls[0]?.url).toBe("https://github.com/acme/site/pull/42");
  });

  it("no-ops when the source has no PR URL", async () => {
    const { ctx, linkPrCalls } = makeCtx({
      orgId: "org-1",
      metadataItemId: "item-1",
    });
    await capturePrForRun(ctx, { stdout: "nothing here" }, null, "thr-x");
    expect(linkPrCalls).toEqual([]);
  });

  it("no-ops without an active organization", async () => {
    const { ctx, linkPrCalls } = makeCtx({ metadataItemId: "item-1" });
    await capturePrForRun(ctx, MCP_RESULT, null, "thr-x");
    expect(linkPrCalls).toEqual([]);
  });

  it("no-ops off a task run (no metadata, no linked threads)", async () => {
    const { ctx, linkPrCalls } = makeCtx({ orgId: "org-1", linked: [] });
    await capturePrForRun(ctx, MCP_RESULT, null, "thr-x");
    expect(linkPrCalls).toEqual([]);
  });
});

describe("resolveAdvanceTargets", () => {
  it("uses the metadata item alone when present (the task's own run)", () => {
    expect(resolveAdvanceTargets("item-1", [])).toEqual(["item-1"]);
  });

  it("never unions metadata with the thread link", () => {
    // The task's own run: metadata wins, link rows are ignored even if present.
    expect(resolveAdvanceTargets("item-1", ["item-2", "item-3"])).toEqual([
      "item-1",
    ]);
  });

  it("falls back to the thread link when there is no metadata", () => {
    // A re-prompted, repo-backed task's 2nd PR carries no run metadata.
    expect(resolveAdvanceTargets(undefined, ["item-2", "item-3"])).toEqual([
      "item-2",
      "item-3",
    ]);
  });

  it("targets nothing when neither resolves (a normal run)", () => {
    expect(resolveAdvanceTargets(undefined, [])).toEqual([]);
  });
});

describe("isPrCreateMcpTool", () => {
  it("matches the GitHub MCP PR-create tools", () => {
    expect(isPrCreateMcpTool("create_pull_request")).toBe(true);
    expect(isPrCreateMcpTool("createPullRequest")).toBe(true);
  });

  it("matches a gateway-prefixed tool name", () => {
    // Observed in the DB: `conn-6-..._create_pull_request`.
    expect(isPrCreateMcpTool("conn-6-mns2esz3z_create_pull_request")).toBe(
      true,
    );
  });

  it("ignores other tools", () => {
    expect(isPrCreateMcpTool("list_pull_requests")).toBe(false);
    expect(isPrCreateMcpTool("pull_request_read")).toBe(false);
    expect(isPrCreateMcpTool("bash")).toBe(false);
  });
});

describe("isPrCreateBashCommand", () => {
  it("matches `gh pr create` with flags and extra whitespace", () => {
    expect(isPrCreateBashCommand("gh pr create")).toBe(true);
    expect(isPrCreateBashCommand("gh pr create --fill --base main")).toBe(true);
    expect(isPrCreateBashCommand("cd repo && gh  pr  create")).toBe(true);
  });

  it("matches a curl REST POST to the GitHub pulls endpoint", () => {
    // The real prod case: agent fell back to curl when the MCP tool 404'd.
    const cmd =
      'cd /app/repo && curl -s -X POST -H "Authorization: token $TOKEN" ' +
      "https://api.github.com/repos/deco-sites/decocms-tanstack/pulls -d '{...}'";
    expect(isPrCreateBashCommand(cmd)).toBe(true);
    expect(
      isPrCreateBashCommand(
        "curl --request POST https://api.github.com/repos/o/r/pulls -d '{}'",
      ),
    ).toBe(true);
  });

  it("does not match unrelated gh / git / curl commands", () => {
    expect(isPrCreateBashCommand("gh pr list")).toBe(false);
    expect(isPrCreateBashCommand("gh pr view 12")).toBe(false);
    expect(isPrCreateBashCommand("git push origin feature")).toBe(false);
    expect(isPrCreateBashCommand("echo create pull request")).toBe(false);
    // GET to /pulls (listing) must not count — only a POST opens a PR.
    expect(
      isPrCreateBashCommand("curl https://api.github.com/repos/o/r/pulls"),
    ).toBe(false);
  });
});

function makeItem(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: "item-1",
    organizationId: "org-1",
    title: "t",
    description: null,
    status: "in_review",
    priority: "medium",
    assigneeId: SUPER_AGENT_ASSIGNEE_ID,
    assignedBy: null,
    repo: null,
    dueDate: null,
    sortOrder: 0,
    retryAttempts: 0,
    threads: [],
    tags: [],
    createdBy: "system",
    createdAt: "now",
    updatedBy: "system",
    updatedAt: "now",
    ...overrides,
  };
}

describe("handTaskToHuman", () => {
  it("records the handover when unassignSuperAgent wins the race", async () => {
    const activityCalls: unknown[] = [];
    const ctx = {
      storage: {
        taskBoard: {
          unassignSuperAgent: async () => makeItem({ assigneeId: null }),
          recordActivity: async (p: unknown) => {
            activityCalls.push(p);
          },
        },
      },
    } as never;
    const handed = await handTaskToHuman(ctx, makeItem(), "burned retries");
    expect(handed).toBe(true);
    expect(activityCalls).toHaveLength(1);
  });

  it("does not record activity when a concurrent reassignment already won", async () => {
    const activityCalls: unknown[] = [];
    const ctx = {
      storage: {
        taskBoard: {
          unassignSuperAgent: async () => null,
          recordActivity: async (p: unknown) => {
            activityCalls.push(p);
          },
        },
      },
    } as never;
    const handed = await handTaskToHuman(ctx, makeItem(), "burned retries");
    expect(handed).toBe(false);
    expect(activityCalls).toHaveLength(0);
  });
});
