import { describe, expect, test } from "bun:test";
import { buildCodingWorkspacePrompt } from "./coding-workspace-prompt";

describe("buildCodingWorkspacePrompt", () => {
  test("renders repo, branch, cwd, and connected GitHub status", () => {
    const prompt = buildCodingWorkspacePrompt({
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
      branch: "feature/chat",
      cwd: "/repo",
      workspaceKind: "github",
    });

    expect(prompt).toContain("<coding-workspace>");
    expect(prompt).toContain("Repository: deco/site");
    expect(prompt).toContain("Branch: feature/chat");
    expect(prompt).toContain("Working directory: /repo");
    expect(prompt).toContain("GitHub linked: yes");
    expect(prompt).toContain(
      "Use the repository and working tree as the source of truth",
    );
    expect(prompt).toContain("Cite files as `path:line`");
  });

  test("omits unknown fields and never renders placeholder values", () => {
    const prompt = buildCodingWorkspacePrompt({
      workspaceKind: "unknown",
    });

    expect(prompt).toContain("<coding-workspace>");
    expect(prompt).not.toContain("Repository:");
    expect(prompt).not.toContain("Branch:");
    expect(prompt).not.toContain("Working directory:");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  test("warns disconnected GitHub workspaces not to assume GitHub operations", () => {
    const prompt = buildCodingWorkspacePrompt({
      repo: {
        owner: "template",
        name: "starter",
        connectedGithub: false,
      },
      cwd: "/repo",
    });

    expect(prompt).toContain("GitHub linked: no");
    expect(prompt).toContain(
      "do not assume PR or GitHub operations are available",
    );
  });

  test("warns template workspaces not to assume GitHub operations even when linked", () => {
    const prompt = buildCodingWorkspacePrompt({
      repo: {
        owner: "template",
        name: "starter",
        connectedGithub: true,
      },
      workspaceKind: "template",
      cwd: "/repo",
    });

    expect(prompt).toContain("GitHub linked: yes");
    expect(prompt).toContain(
      "do not assume PR or GitHub operations are available",
    );
  });

  test("warns local workspaces not to assume GitHub operations even without repo metadata", () => {
    const prompt = buildCodingWorkspacePrompt({
      workspaceKind: "local",
      cwd: "/repo",
    });

    expect(prompt).not.toContain("GitHub linked:");
    expect(prompt).toContain(
      "do not assume PR or GitHub operations are available",
    );
  });

  test("warns local workspaces not to assume GitHub operations even when linked", () => {
    const prompt = buildCodingWorkspacePrompt({
      repo: {
        owner: "local",
        name: "workspace",
        connectedGithub: true,
      },
      workspaceKind: "local",
      cwd: "/repo",
    });

    expect(prompt).toContain("GitHub linked: yes");
    expect(prompt).toContain(
      "do not assume PR or GitHub operations are available",
    );
  });

  test("includes Deco CMS content rules only when isDecoSite is set", () => {
    const decoPrompt = buildCodingWorkspacePrompt({
      repo: { owner: "deco", name: "site", connectedGithub: true },
      workspaceKind: "github",
      cwd: "/repo",
      isDecoSite: true,
    });
    expect(decoPrompt).toContain("This is a Deco CMS site");
    expect(decoPrompt).toContain(".deco/blocks/<encoded-key>.json");
    expect(decoPrompt).toContain("NEVER edit generated artifacts");
    expect(decoPrompt).toContain("blocks.gen.json");
    expect(decoPrompt).toContain("AGENTS.md");
  });

  test("omits Deco CMS content rules for non-deco or unverified workspaces", () => {
    for (const input of [
      undefined,
      { workspaceKind: "local" as const },
      // A repo workspace that was NOT confirmed to be a deco site.
      {
        repo: { owner: "deco", name: "site", connectedGithub: true },
        workspaceKind: "github" as const,
        cwd: "/repo",
      },
      // Explicitly not a deco site.
      {
        repo: { owner: "acme", name: "app", connectedGithub: true },
        workspaceKind: "github" as const,
        cwd: "/repo",
        isDecoSite: false,
      },
    ]) {
      const prompt = buildCodingWorkspacePrompt(input);
      expect(prompt).not.toContain("This is a Deco CMS site");
      expect(prompt).not.toContain(".deco/blocks/<encoded-key>.json");
      expect(prompt).not.toContain("NEVER edit generated artifacts");
    }
  });

  test("does not include Decopilot-only tool vocabulary", () => {
    const prompt = buildCodingWorkspacePrompt({
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
    });

    expect(prompt).not.toContain("<available-agents>");
    expect(prompt).not.toContain("<available-prompts>");
    expect(prompt).not.toContain("<connections-usage>");
    expect(prompt).not.toContain("enable_tool");
    expect(prompt).not.toContain("read_prompt");
    expect(prompt).not.toContain("todo_write");
  });
});
