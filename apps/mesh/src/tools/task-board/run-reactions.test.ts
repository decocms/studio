import { describe, expect, it } from "bun:test";
import { isPrCreateBashCommand, isPrCreateMcpTool } from "./run-reactions";

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
