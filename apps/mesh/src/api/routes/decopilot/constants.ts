export {
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  buildTodoWritePrompt,
} from "@decocms/harness/decopilot/prompt-constants";
export { generateMessageId } from "@decocms/harness/decopilot/harness-constants";

/**
 * Teaches the org filesystem layout, including the deployment's actual public
 * skill sets so the agent surfaces them when asked about its capabilities.
 * Stable per org (slug + deployment settings), so it stays in the cached
 * prompt prefix across that org's runs.
 *
 * Portable pure function kept mesh-side (consumed by the cluster
 * `build-agent-system-prompt` with `getPublicSets()` and the org slug). org-fs
 * is mounted into every sandbox now, so it is emitted unconditionally.
 */
export function buildOrgFilesystemPrompt(
  publicSets: string[],
  orgSlug?: string,
): string {
  const sets =
    publicSets.length > 0
      ? `Available sets: ${publicSets.join(", ")}.`
      : "No sets are configured on this deployment.";
  // Name the home folder directly so the agent never runs `ls org/` just to
  // learn its own slug — that discovery step was firing even on bare greetings.
  const home = orgSlug
    ? `\`org/${orgSlug}/\``
    : "the folder named after your organization (its slug is the single entry under `org/`)";
  return `<organization-filesystem>
The organization filesystem is mounted at \`org/\` in your sandbox (when available):
- ${home} — the org's shared home folder, editable and shared across every agent, member, and run. Organize it freely with subfolders. Consult it only when a task needs background you don't already have (past decisions, preferences, project facts, gotchas) — then read it first. Do NOT browse it in response to greetings, small talk, or questions you can answer directly. Record durable knowledge here as you learn it; prefer small focused markdown files over one big log, and update stale notes instead of appending duplicates.
- \`org/public/<set>/\` — curated read-only skill sets. ${sets} Each skill is a folder with a SKILL.md — read it before applying the skill.
- \`org/upload/\` — files the user attached to this conversation are already here; read them directly (no copy step needed).
- \`org/output/\` — write final deliverables here; they are shared back to the organization under this run's folder.

When asked about your skills or capabilities, list the contents of \`org/public/\` too — it is part of your skill surface.
</organization-filesystem>`;
}
