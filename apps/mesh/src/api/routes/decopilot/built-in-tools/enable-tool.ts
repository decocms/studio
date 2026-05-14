/**
 * Enable Tool
 *
 * Activates tools from the current agent's catalog. The catalog (shown to
 * the model in <available-connections>) uses short tool names like
 * `send_email`. Short names are resolved against the set of fully-prefixed
 * safe names; when a short name maps to more than one connection, the
 * call returns an `ambiguous` row so the model can retry with the full id.
 *
 * Tools enabled in step N become callable in step N+1 via the
 * prepareStep callback in dispatch-run.
 */

import { tool } from "ai";
import { z } from "zod";

export const EnableToolInputSchema = z.object({
  tools: z
    .array(z.string())
    .min(1)
    .describe(
      "Tool ids to enable. Pass short names like `send_email`. If a name " +
        "is ambiguous across connections, the response will list candidates " +
        "and the tool is not enabled — retry with the fully-qualified id.",
    ),
});

/**
 * @param enabledTools     - Shared set updated with enabled full safe names.
 * @param availableToolNames - Full safe names exposed by the current Virtual
 *                             MCP's passthrough client (collision-prefixed).
 * @param options.connectionIds - Connection ids known to the agent; used to
 *                                strip prefixes when building the short-name
 *                                index. When absent, short-name resolution
 *                                is disabled and only exact matches enable.
 */
export function createEnableToolTool(
  enabledTools: Set<string>,
  availableToolNames: Set<string>,
  options?: {
    isPlanMode?: boolean;
    toolAnnotations?: Map<string, { readOnlyHint?: boolean }>;
    connectionIds?: string[];
  },
) {
  const shortNameIndex = buildShortNameIndex(
    availableToolNames,
    options?.connectionIds ?? [],
  );

  return tool({
    description:
      "Enable tools from the current agent's catalog so they can be called " +
      "in subsequent steps. Pass short tool names like `send_email`; if the " +
      "name is ambiguous across connections, the response includes " +
      "`ambiguous` with candidates and you must retry with the full id.\n\n" +
      "Usage notes:\n" +
      "- Built-in tools (user_ask, subtask, read_tool_output, read_prompt, " +
      "read_resource, sandbox) are always available and do not need enabling.",
    inputSchema: EnableToolInputSchema,
    execute: async ({ tools }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];
      const blocked: string[] = [];
      const ambiguous: Array<{ name: string; candidates: string[] }> = [];

      for (const requested of tools) {
        const resolved = resolveName(
          requested,
          availableToolNames,
          shortNameIndex,
        );

        if (resolved.kind === "not_found") {
          notFound.push(requested);
          continue;
        }
        if (resolved.kind === "ambiguous") {
          ambiguous.push({ name: requested, candidates: resolved.candidates });
          continue;
        }

        const fullName = resolved.fullName;

        if (options?.isPlanMode) {
          const annotations = options.toolAnnotations?.get(fullName);
          if (annotations?.readOnlyHint !== true) {
            blocked.push(fullName);
            continue;
          }
        }

        enabledTools.add(fullName);
        enabled.push(fullName);
      }

      return {
        enabled,
        ...(notFound.length > 0 && { not_found: notFound }),
        ...(blocked.length > 0 && {
          blocked,
          blocked_reason:
            "These tools cannot be enabled in plan mode — they have side effects.",
        }),
        ...(ambiguous.length > 0 && { ambiguous }),
      };
    },
  });
}

type ResolveResult =
  | { kind: "exact"; fullName: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not_found" };

function resolveName(
  requested: string,
  availableToolNames: Set<string>,
  shortNameIndex: Map<string, string[]>,
): ResolveResult {
  if (availableToolNames.has(requested)) {
    return { kind: "exact", fullName: requested };
  }
  const candidates = shortNameIndex.get(requested);
  if (!candidates || candidates.length === 0) {
    return { kind: "not_found" };
  }
  if (candidates.length === 1) {
    return { kind: "exact", fullName: candidates[0]! };
  }
  return { kind: "ambiguous", candidates: [...candidates].sort() };
}

function buildShortNameIndex(
  availableToolNames: Set<string>,
  connectionIds: string[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const fullName of availableToolNames) {
    for (const connId of connectionIds) {
      const prefix = `${connId}_`;
      if (fullName.startsWith(prefix)) {
        const short = fullName.slice(prefix.length);
        const list = index.get(short);
        if (list) list.push(fullName);
        else index.set(short, [fullName]);
        break;
      }
    }
  }
  return index;
}
