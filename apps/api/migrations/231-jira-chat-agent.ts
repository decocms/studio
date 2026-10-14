/**
 * Created a code-owned "Jira" agent for orgs with an enabled Jira integration.
 * The agent was removed: the `JIRA_*` tools stay on the org's `self`
 * connection, and an org that wants a Jira agent builds an ordinary one over
 * them. Kept as a no-op because databases have already run it; 233 deletes
 * the agents it created.
 */
export async function up(): Promise<void> {}

export async function down(): Promise<void> {}
