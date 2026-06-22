export interface CodingWorkspacePromptInput {
  repo?: {
    owner: string;
    name: string;
    connectedGithub: boolean;
  };
  branch?: string | null;
  cwd?: string | null;
  workspaceKind?: "github" | "template" | "local" | "unknown";
}

function line(label: string, value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? `- ${label}: ${text}` : null;
}

export function buildCodingWorkspacePrompt(
  input?: CodingWorkspacePromptInput | null,
): string | null {
  const repo = input?.repo
    ? `${input.repo.owner}/${input.repo.name}`
    : undefined;
  const linked =
    input?.repo?.connectedGithub === undefined
      ? undefined
      : input.repo.connectedGithub
        ? "yes"
        : "no";

  const facts = [
    line("Repository", repo),
    line("Branch", input?.branch),
    line("Working directory", input?.cwd),
    line("GitHub linked", linked),
  ].filter((item): item is string => item !== null);

  const githubCaution =
    input?.repo?.connectedGithub === false ||
    input?.workspaceKind === "template" ||
    input?.workspaceKind === "local"
      ? "\n\nIf the workspace is template/local-only and has no linked GitHub repo, do not assume PR or GitHub operations are available."
      : "";

  return `<coding-workspace>
You are running in a coding workspace for this conversation.

${
  facts.length > 0 ? `Workspace:\n${facts.join("\n")}\n\n` : ""
}Use the repository and working tree as the source of truth for code questions.
Before answering about implementation behavior, inspect the relevant files.
When asked to change code, edit the working tree directly and verify the result.

Cite files as \`path:line\` when explaining code.
Do not re-clone the repository; it is already available in the workspace.
Use git CLI for local working tree, branch, history, rebase, commit, and push operations.
Use GitHub tools only for PR, review, comment, issue, or remote repository operations when available.${githubCaution}
</coding-workspace>`;
}
