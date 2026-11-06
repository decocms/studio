/**
 * Whether a project is a Blocks v8 site, for Studio's editor and hosted
 * screens: the project's "Blocks v8 site" switch alone (`isBlocksV8Project`),
 * which only an org admin turns on, in project settings. Every web v8 gate
 * (the editor, Experiments, Calendar, Releases, site tokens, Monitor) asks
 * here. Nothing reads main's schema, git or `deco schema push` for it.
 *
 * - `"v8"` / `"v7"`: the switch is on / off.
 * - `"loading"` / `"error"`: kept for the callers that still tell them
 *   apart; the switch never answers them.
 */

import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useVirtualMCP } from "@/sdk";

export type MainSchemaAnswer = "v8" | "v7" | "loading" | "error";

/** The answer for a project in hand (pure, for tests). */
export function projectMainSchemaAnswer(
  project: VirtualMCPEntity | null | undefined,
): MainSchemaAnswer {
  return isBlocksV8Project(project?.metadata) ? "v8" : "v7";
}

export function useMainSchemaV8(
  virtualMcpId: string | null | undefined,
): MainSchemaAnswer {
  return projectMainSchemaAnswer(useVirtualMCP(virtualMcpId));
}

/** {@link useMainSchemaV8} for a caller that already holds the project. Never
 *  suspends, so the sidebar can use it: reading the row by id there suspended
 *  the whole org frame on the first visit to a project. */
export function useProjectMainSchemaV8(
  project: VirtualMCPEntity | null | undefined,
): MainSchemaAnswer {
  return projectMainSchemaAnswer(project);
}

/** {@link useProjectMainSchemaV8} for several projects at once, in their order. */
export function useProjectsMainSchemaV8(
  projects: readonly (VirtualMCPEntity | undefined)[],
): MainSchemaAnswer[] {
  return projects.map(projectMainSchemaAnswer);
}

/**
 * Whether the project's "Blocks v8 site" switch is on. Tells a failing
 * sandbox on a v8 site (waits) from any other one (the v7 sandbox editor).
 */
export function useLastFoundV8(
  virtualMcpId: string | null | undefined,
): boolean {
  return lastFoundV8(useVirtualMCP(virtualMcpId));
}

/** {@link useLastFoundV8} for a caller that already holds the project (the
 *  sidebar, which must not suspend). */
export function lastFoundV8(
  project: VirtualMCPEntity | null | undefined,
): boolean {
  return isBlocksV8Project(project?.metadata);
}
