export {
  DEFAULT_THREAD_TITLE,
  DEFAULT_WINDOW_SIZE,
  buildTodoWritePrompt,
} from "@decocms/harness/decopilot/prompt-constants";
export { generateMessageId } from "@decocms/harness/decopilot/harness-constants";

/**
 * Teaches the org filesystem layout, including the deployment's actual public
 * skill sets so the agent surfaces them when asked about its capabilities.
 * Settings-stable per deployment, so it lives in the cached prompt prefix.
 *
 * Portable pure function but kept mesh-side (consumed by the cluster
 * `build-agent-system-prompt`, which gates it on `getSettings().orgFsClusterMounts`
 * + `getPublicSets()` — both cluster-only).
 */
export function buildOrgFilesystemPrompt(publicSets: string[]): string {
  const sets =
    publicSets.length > 0
      ? `Available sets: ${publicSets.join(", ")}.`
      : "No sets are configured on this deployment.";
  return `<organization-filesystem>
The organization filesystem is mounted at \`org/\` in your sandbox (when available):
- \`org/public/<set>/\` — curated read-only skill sets. ${sets} Each skill is a folder with a SKILL.md — read it before applying the skill.
- \`org/upload/\` — files the user attached to this conversation are already here; read them directly (no copy step needed).
- \`org/output/\` — write final deliverables here; they are shared back to the organization under this run's folder.

When asked about your skills or capabilities, list the contents of \`org/public/\` too — it is part of your skill surface.
</organization-filesystem>`;
}
