export interface CodingWorkspacePromptInput {
  repo?: {
    owner: string;
    name: string;
    connectedGithub: boolean;
  };
  branch?: string | null;
  cwd?: string | null;
  workspaceKind?: "github" | "template" | "local" | "unknown";
  /**
   * Whether the attached workspace is a Deco CMS site (its checkout contains a
   * `.deco/` directory). Gates the {@link DECO_CMS_CONTENT_RULES} block — the
   * caller resolves this against the sandbox the agent is attached to (local fs
   * for the in-sandbox CLI harnesses, the sandbox-fs proxy for the cluster
   * engine). Absent/false ⇒ the CMS rules are omitted, so non-deco workspaces
   * don't carry the dead-weight instructions.
   */
  isDecoSite?: boolean;
}

function line(label: string, value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? `- ${label}: ${text}` : null;
}

/**
 * CMS-content rules for Deco sites. Rendered only when the caller has confirmed
 * the attached workspace is a Deco site (`isDecoSite` — resolved against the
 * sandbox `.deco/` directory), so non-deco workspaces don't carry it as dead
 * weight. Getting this wrong is silent data loss — `blocks.gen.json` edits
 * render in the dev preview but are regenerated from `.deco/blocks/` on every
 * production build, so the change never reaches the deployed site.
 */
const DECO_CMS_CONTENT_RULES = `This is a Deco CMS site (its repository contains a \`.deco/\` directory). These rules apply to content changes (page copy, section props, loader config, site settings):

- CMS content lives in \`.deco/blocks/<encoded-key>.json\` — one JSON file per block, filename is the URI-encoded block key. Edit ONLY the matching \`.deco/blocks/*.json\` file(s).
- NEVER edit generated artifacts: \`blocks.gen.json\`, \`blocks.gen.ts\`, \`meta.gen.json\`, or any other \`*.gen.*\` file. They are regenerated from \`.deco/blocks/\` by the dev server and by every production build — an edit there looks correct in the preview but is silently discarded on deploy.
- Do not touch any other file to make a content change visible: the dev server watches \`.deco/blocks/\` and hot-reloads the preview, and production builds/content syncs read \`.deco/blocks/\` directly. Committing the \`.deco/blocks/*.json\` change is all that is needed.
- After making a CMS content change, check the repo's AGENTS.md: if it is missing or does not document these \`.deco/\` content rules, add a short "Deco CMS content" section (creating AGENTS.md if needed) so other tools working in this repo follow the same rules. If AGENTS.md already documents them, leave it untouched.`;

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
The preview hot-reloads from the working tree, so your edits are immediately visible to the user — that IS how a change ships in this workspace, and it is the default "done" for a change request. Opening a pull request is a SEPARATE, explicit step that does NOT update the running preview: never open or push a PR to "finish" a change. Only open a PR when the user explicitly asks to publish, ship, or open one.

Cite files as \`path:line\` when explaining code.
Do not re-clone the repository; it is already available in the workspace.
Use git CLI for local working tree, branch, history, rebase, commit, and push operations.
Use GitHub tools only for PR, review, comment, issue, or remote repository operations when available.${githubCaution}${
    input?.isDecoSite ? `\n\n${DECO_CMS_CONTENT_RULES}` : ""
  }
</coding-workspace>`;
}
