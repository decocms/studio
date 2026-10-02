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
  view: z.string().max(100).optional(),
  group: z.string().max(100).optional(),
  subgroup: z.string().max(100).optional(),
  sort: z.string().max(100).optional(),
  dir: z.string().max(100).optional(),
  q: z.string().max(500).optional(),
  assignee: z.string().max(100).optional(),
  priority: z.string().max(100).optional(),
  due: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
  repo: z.string().max(100).optional(),
  /** Another tenant's board, shown WITHOUT leaving this org. Admin-org only;
   *  ignored when the caller cannot read it. See `board-org.tsx`. */
  boardOrg: z.string().max(100).optional(),
};

/** Library-owned browse, preview, and catalog state. `layout` and `sort` are
 *  in the URL with the rest so a link carries the listing someone is looking
 *  at, not just the folder it is in. Both `.catch()` to their default: a stale
 *  link with a retired value opens the Library, never a blank route. */
export const librarySearchShape = {
  fileView: z.enum(["all", "documents", "media"]).catch("all").optional(),
  layout: z.enum(["list", "grid"]).catch("list").optional(),
  sort: z.enum(["name", "updated", "size"]).catch("name").optional(),
  path: z.string().max(2048).optional(),
  preview: z.string().max(2048).optional(),
  skill: z.string().max(100).optional(),
  brand: z.string().max(100).optional(),
};

/** Exact payload accepted by the retired `/agents/{-$panel}` route. */
const legacyAgentViewSearchShape = {
  file: z.string().max(100).optional(),
  key: z.string().max(100).optional(),
  deck: z.string().max(100).optional(),
  path: z.string().max(2048).optional(),
  connection: z.string().max(100).optional(),
  tool: z.string().max(100).optional(),
  automation: z.string().max(100).optional(),
  section: z.string().max(100).optional(),
  preview: z.string().max(2048).optional(),
  autosend: z.string().max(100).optional(),
  connect: z.coerce.string().optional(),
  siteUrl: z.string().max(2048).optional(),
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
  task: z.string().max(100).optional(),
  /** The flat shape's project pointer (`lib/flat-projects.ts`). On the shared
   *  payload rather than its own route: it has to survive the workspace's
   *  navigations, and one more route breaks search inference. */
  project: z.string().max(100).optional(),
  ...taskBoardSearchShape,
  /** `path` and `preview` already come from the agent-view payload above. */
  skill: librarySearchShape.skill,
  brand: librarySearchShape.brand,
};

export const legacyWorkspaceCompatibilitySearchSchema = z.object(
  legacyWorkspaceCompatibilitySearchShape,
);
