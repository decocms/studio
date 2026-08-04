import { describe, expect, test } from "bun:test";
import {
  buildClaudeCodeTaskPrompt,
  pickSoleTaskRepo,
  type TaskRepo,
} from "./claude-code-task-run";

const repo: TaskRepo = {
  connectionId: "conn_1",
  owner: "acme",
  name: "web",
  installationId: 42,
  url: "https://github.com/acme/web",
};

const task = {
  id: "tbi_1",
  title: "Add a health endpoint",
  description: "Return 200 from /healthz",
};

describe("buildClaudeCodeTaskPrompt", () => {
  test("states the task and that the repo is already checked out", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("Add a health endpoint");
    expect(prompt).toContain("Return 200 from /healthz");
    expect(prompt).toContain("acme/web is already cloned");
  });

  test("omits the description block when there is none", () => {
    const prompt = buildClaudeCodeTaskPrompt(
      { ...task, description: null },
      repo,
    );
    expect(prompt).not.toContain("Description:");
  });

  test("asks for a pull request and for the board move, with the task id", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("open a pull request");
    // The board move is the whole reason the run needs the Studio MCP.
    expect(prompt).toContain("mcp__studio__TASK_BOARD_ITEM_UPDATE");
    expect(prompt).toContain('id "tbi_1"');
    expect(prompt).toContain('"in_review"');
  });

  test("says it runs autonomously", () => {
    expect(buildClaudeCodeTaskPrompt(task, repo)).toContain("AUTONOMOUSLY");
  });

  test("reviewer feedback leads, and updates the existing PR", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Missing a test.",
      pr: { number: 7, url: "https://github.com/acme/web/pull/7" },
    });
    expect(prompt).toContain("Missing a test.");
    expect(prompt).toContain("gh pr checkout 7");
    expect(prompt).toContain("do NOT open a new one");
  });

  test("feedback with no PR asks for the fix without a checkout", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Wrong approach.",
    });
    expect(prompt).toContain("Wrong approach.");
    expect(prompt).not.toContain("gh pr checkout");
  });

  test("conflict resolution wins over feedback when both are set", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Missing a test.",
      resolveConflict: true,
      pr: { number: 9, url: "https://github.com/acme/web/pull/9" },
    });
    expect(prompt).toContain("MERGE CONFLICT");
    expect(prompt).toContain("gh pr checkout 9");
    expect(prompt).not.toContain("Missing a test.");
  });

  test("a conflict flag with no PR is ignored — nothing to check out", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      resolveConflict: true,
    });
    expect(prompt).not.toContain("MERGE CONFLICT");
  });

  test("a fresh attempt does not mention an existing PR", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).not.toContain("gh pr checkout");
    expect(prompt).not.toContain("existing one");
  });
});

/** An active repo-scoped `mcp-github` connection, as `connections.list` returns it. */
const repoConn = (
  id: string,
  owner: string,
  name: string,
  extra?: Record<string, unknown>,
) => ({
  id,
  status: "active",
  metadata: {
    ...extra,
    repoScope: { installationId: 42, owner, repo: name },
  },
});

describe("pickSoleTaskRepo", () => {
  test("no imported repo is not eligible", () => {
    expect(pickSoleTaskRepo([])).toBeNull();
    // The bare org-level connection carries no repoScope.
    expect(
      pickSoleTaskRepo([{ id: "conn_0", status: "active", metadata: {} }]),
    ).toBeNull();
  });

  test("one repo, one connection", () => {
    expect(pickSoleTaskRepo([repoConn("conn_1", "acme", "web")])).toEqual({
      connectionId: "conn_1",
      owner: "acme",
      name: "web",
      installationId: 42,
      url: "https://github.com/acme/web",
    });
  });

  // The regression: importing one repo leaves an org-shared connection AND a
  // per-agent one behind. Counting connections read that as "ambiguous".
  test("one repo behind two connections is still one repo, org-shared wins", () => {
    const picked = pickSoleTaskRepo([
      repoConn("conn_agent", "acme", "web"),
      repoConn("conn_shared", "acme", "web", { orgShared: true }),
    ]);
    expect(picked?.connectionId).toBe("conn_shared");
  });

  test("falls back to the per-agent connection when none is org-shared", () => {
    const picked = pickSoleTaskRepo([repoConn("conn_agent", "acme", "web")]);
    expect(picked?.connectionId).toBe("conn_agent");
  });

  test("owner/repo case does not split one repo into two", () => {
    const picked = pickSoleTaskRepo([
      repoConn("conn_1", "acme", "web"),
      repoConn("conn_2", "Acme", "Web"),
    ]);
    expect(picked).not.toBeNull();
  });

  test("two different repos stay ambiguous", () => {
    expect(
      pickSoleTaskRepo([
        repoConn("conn_1", "acme", "web"),
        repoConn("conn_2", "acme", "api"),
      ]),
    ).toBeNull();
  });

  test("an inactive connection does not count as an imported repo", () => {
    const picked = pickSoleTaskRepo([
      repoConn("conn_1", "acme", "web"),
      { ...repoConn("conn_2", "acme", "api"), status: "inactive" },
    ]);
    expect(picked?.owner).toBe("acme");
    expect(picked?.name).toBe("web");
  });
});

describe("buildClaudeCodeTaskPrompt with no repo (several in the org)", () => {
  test("says the working directory is empty and to call TASK_ADD_REPO first", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("EMPTY");
    expect(prompt).toContain("TASK_ADD_REPO");
    // The failure this wording exists to prevent: the model opening with a
    // file hunt in a directory nothing has cloned into yet.
    expect(prompt).toContain("Do not read files");
    expect(prompt).not.toContain("is already cloned");
  });

  test("still says how to finish", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("TASK_BOARD_ITEM_UPDATE");
    expect(prompt).toContain("in_review");
  });
});

describe("buildClaudeCodeTaskPrompt repo choices", () => {
  test("names the candidate repos so the run doesn't have to ask", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null, {
      repoChoices: [
        { connectionId: "conn_1", repo: "acme/web" },
        { connectionId: "conn_2", repo: "acme/api" },
      ],
    });
    expect(prompt).toContain("acme/web (connectionId: conn_1)");
    expect(prompt).toContain("acme/api (connectionId: conn_2)");
    expect(prompt).toContain("Pick the one the task is about");
  });

  test("falls back to the listing call when no candidates were resolved", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("with no arguments to list them");
  });
});
