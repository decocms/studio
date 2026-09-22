/**
 * Route-owned search accepted while a retired workspace URL is being
 * canonicalized.
 *
 * TanStack validates every matched route before a redirect runs. A
 * compatibility route therefore has to declare the union of every payload
 * that its eventual destination may own; otherwise an intermediate
 * `/agents` or project-first hop silently strips state before the translator
 * can move it to Tasks, Library, Site Editor, or an agent view.
 *
 * Shell-owned identity/layout keys (`main`, `virtualmcpid`, `thread`, and the
 * panel booleans) stay on the shell or the one org-index boundary that sits
 * outside it. This module owns the complete destination payload only.
 */

import { z } from "zod";
import { contentSearchParams } from "@/components/sandbox/content/content-search-params";

/** Content deep-link payload shared by the canonical Site Editor route and
 * compatibility boundaries that must carry it there. */
export const siteEditorContentSearchShape = contentSearchParams;

/** Task board view/filter state that has to survive legacy workspace hops. */
export const taskBoardSearchShape = {
  forumFilter: z.string().optional(),
  forumSort: z.string().optional(),
  view: z.string().optional(),
  q: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  due: z.string().optional(),
  tags: z.string().optional(),
  repo: z.string().optional(),
  /** Another tenant's board, shown WITHOUT leaving this org. Admin-org only;
   *  ignored when the caller cannot read it. See `board-org.tsx`. */
  boardOrg: z.string().optional(),
};

/** Library-owned browse, preview, and catalog state. */
export const librarySearchShape = {
  fileView: z.enum(["all", "documents", "media"]).catch("all").optional(),
  path: z.string().optional(),
  preview: z.string().optional(),
  skill: z.string().optional(),
  brand: z.string().optional(),
};

/** Exact payload accepted by the retired `/agents/{-$panel}` route. */
const legacyAgentViewSearchShape = {
  file: z.string().optional(),
  key: z.string().optional(),
  deck: z.string().optional(),
  path: z.string().optional(),
  connection: z.string().optional(),
  tool: z.string().optional(),
  automation: z.string().optional(),
  section: z.string().optional(),
  preview: z.string().optional(),
  autosend: z.string().optional(),
  connect: z.coerce.string().optional(),
  siteUrl: z.string().optional(),
  ...siteEditorContentSearchShape,
};

/**
 * Complete route-owned payload for every workspace compatibility entry.
 * Fields shared by two destinations intentionally appear once here, so adding
 * a new compatibility hop cannot make their accepted shapes drift apart.
 */
export const legacyWorkspaceCompatibilitySearchShape = {
  ...legacyAgentViewSearchShape,
  /** A retired board link carried the selected card in search. */
  task: z.string().optional(),
  ...taskBoardSearchShape,
  /** `path` and `preview` already come from the agent-view payload above. */
  skill: librarySearchShape.skill,
  brand: librarySearchShape.brand,
};

export const legacyWorkspaceCompatibilitySearchSchema = z.object(
  legacyWorkspaceCompatibilitySearchShape,
);
