export {
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  buildTodoWritePrompt,
} from "@decocms/harness/decopilot/prompt-constants";
export { generateMessageId } from "@decocms/harness/message-id";

/**
 * Teaches the org filesystem layout. Skill discovery now lives in the
 * `<available-skills>` catalog + the `skill` tool, so this block no longer
 * enumerates sets or tells the agent to `ls org/public/` — it just names the
 * mount points. The home folder mounts at the fixed `org/home/` (same path for
 * every org), so this block is identical across orgs and fully cache-stable.
 *
 * Portable pure function kept studio-side (consumed by the cluster
 * `build-agent-system-prompt`). org-fs is mounted into every sandbox now, so it
 * is emitted unconditionally.
 */
export function buildOrgFilesystemPrompt(userId?: string): string {
  const orgMemoryPath = "`org/home/MEMORY.md`";
  const userMemoryPath = `\`org/home/users/${userId ?? "<your-user-id>"}/MEMORY.md\``;
  return `<organization-filesystem>
The organization filesystem is mounted at \`org/\` in your sandbox (when available):
- \`org/home/\` — the org's shared home folder, editable and shared across every agent, member, and run. Organize it freely with subfolders. Consult it only when a task needs background you don't already have (past decisions, preferences, project facts, gotchas) — then read it first. Do NOT browse it in response to greetings, small talk, or questions you can answer directly. Record durable knowledge here as you learn it; prefer small focused markdown files over one big log, and update stale notes instead of appending duplicates.
- ${orgMemoryPath} — the ORGANIZATION memory index: durable facts shared with everyone in this org. Auto-loaded into context at the start of every session (its current contents appear in the <organization-memory> block when it exists).
- ${userMemoryPath} — your USER memory index: facts and preferences specific to the current user, not shared with other members. Auto-loaded each session (shown in the <user-memory> block when it exists).
Keep both indexes concise — a curated list of durable facts and one-line pointers to deeper notes elsewhere in the home folder. When you learn something worth remembering across sessions, edit the matching file (user-specific → user memory; org-wide → organization memory); update existing lines instead of appending duplicates.
- \`org/public/<set>/\` — curated read-only skill sets, mounted here. Your skills are listed in the <available-skills> catalog; load one with the \`skill\` tool before applying it.
- \`org/upload/\` — files the user attached to this conversation are already here; read them directly (no copy step needed).
- \`org/output/\` — write final deliverables here; they are shared back to the organization under this run's folder.
</organization-filesystem>`;
}
