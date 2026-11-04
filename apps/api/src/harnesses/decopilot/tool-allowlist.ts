/**
 * Scoping a run's tools to an allowlist.
 *
 * Two callers, with the same rules: a run started with an explicit tool list
 * (an automation's picker), and a subagent whose definition names the few
 * tools its role actually needs. Both want the same answer to "may this one be
 * called", so neither gets its own.
 */

import type { ToolSet } from "ai";

/**
 * Built-in tools the agent loop depends on for mechanics (reading truncated
 * outputs, the connections-block lazy-load via enable_tool, todo tracking).
 * These are NEVER subject to the per-run allowlist — removing them would break
 * the loop rather than scope it. The allowlist governs everything else: MCP
 * tools, the user-facing capability built-ins (web_search, generate_image,
 * subtask, …), the VM file tools, the browser tools, and read_resource /
 * read_prompt — all selectable in the automations tool picker.
 */
const ALLOWLIST_EXEMPT_BUILTINS = new Set<string>([
  "read_tool_output",
  "enable_tool",
  "open_in_agent",
  "todo_write",
  "update_interests",
]);

/**
 * The gateway's namespace prefix: `a` plus six base36 characters of a hash of
 * the connection id, and never an underscore (see `namespaceCode`). Matching
 * the shape rather than recomputing the code is what lets this filter work
 * without knowing which connection a tool came from.
 */
const NAMESPACE_CODE = /^a[0-9a-z]{6}_/;

/**
 * A tool's own name, with the gateway's connection prefix taken off.
 *
 * An allowlist is written by a person — `BLOG_STATE_GET`, not
 * `asfcidh_BLOG_STATE_GET` — and which connection serves a tool is not
 * something they can know in advance, nor something that should change whether
 * a role may call it.
 */
function bareToolName(name: string): string {
  return name.replace(NAMESPACE_CODE, "");
}

/**
 * Filter the passthrough (MCP) tool set against the allowlist. The allowlist
 * carries the RAW tool names the UI lists (from `listTools()`), so an MCP
 * tool's model-facing (safe) key survives iff its raw name, its safe name, or
 * either with the gateway prefix removed is allowed. A null allowlist is a
 * no-op.
 */
export function filterPassthroughByAllowlist(
  set: ToolSet,
  nameMap: Map<string, string>,
  allow: Set<string> | null,
): ToolSet {
  if (!allow) return set;
  const allowedSafe = new Set<string>();
  for (const [raw, safe] of nameMap) {
    if (
      allow.has(raw) ||
      allow.has(safe) ||
      allow.has(bareToolName(raw)) ||
      allow.has(bareToolName(safe))
    ) {
      allowedSafe.add(safe);
    }
  }
  return Object.fromEntries(
    Object.entries(set).filter(([name]) => allowedSafe.has(name)),
  );
}

/**
 * Filter built-ins against the allowlist, always keeping the loop-essential
 * ones. A null allowlist is a no-op.
 */
export function filterBuiltInsByAllowlist(
  set: ToolSet,
  allow: Set<string> | null,
): ToolSet {
  if (!allow) return set;
  return Object.fromEntries(
    Object.entries(set).filter(
      ([name]) => ALLOWLIST_EXEMPT_BUILTINS.has(name) || allow.has(name),
    ),
  );
}
