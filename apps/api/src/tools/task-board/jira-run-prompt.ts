/**
 * What a Jira-triggered run is told beyond the issue itself — which is now
 * one fact, not a script.
 *
 * It used to be a script: a default lead, a "how to finish" block, and a
 * reporting block naming every Jira tool. All of it arrived implicitly, so the
 * prompt a person wrote on the column rule was a fraction of what the run
 * actually read, and changing the rest meant changing this file. Worse, the
 * script only fit one shape of run — implement the issue and open a pull
 * request — while the process it automates is two columns and two runs, one
 * implementing and a later one reviewing. A reviewer told to "open a pull
 * request" redoes the work and leaves a second one on the issue.
 *
 * So the script moved out, into two skills a person inserts into the rule's
 * prompt and can then read and edit as ordinary text
 * (`packages/sandbox/image/skills/jira-{execute,review}`). What stays here is
 * the one thing the author of that text cannot know or state.
 */

/**
 * The tool namespace, stated as a fact.
 *
 * Skills name tools bare; a sandbox-hosted run reaches Studio over MCP and sees
 * `mcp__studio__JIRA_COMMENT_ADD`. Without this the model spends a tool search
 * on a name it has never been shown — the failure observed on the first
 * production run.
 */
export const STUDIO_TOOL_NAMESPACE_FACT =
  "Your Studio tools are namespaced `mcp__studio__`: where an instruction names a tool `JIRA_COMMENT_ADD`, the tool you actually call is `mcp__studio__JIRA_COMMENT_ADD`. Don't search for the unprefixed name.";
