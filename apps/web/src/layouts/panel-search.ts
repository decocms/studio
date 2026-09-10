/**
 * The two panel-visibility search params — and the shapes `?sidepanel` used to
 * have.
 *
 * `?sidepanel` and `?mainpanel` are symmetric booleans: is the chat panel open,
 * is the main panel open. Which VIEW the main panel shows is not here at all —
 * that is the `{-$panel}` path segment (see `main-panel-tabs/panel-route.ts`).
 * Splitting them is what lets a view be a path segment: `?main=0` used to mean
 * "closed", which no segment can express, and closing a panel had to forget
 * which view it was on.
 *
 * `?sidepanel` shipped as `?sidepanel=chat` / `?sidepanel=0` first, and those
 * URLs are in bookmarks, shared links and pasted messages that outlive the
 * rename. A search schema that throws on them is a full-page "Something went
 * wrong" for a *layout* hint, so the legacy pair is translated instead of
 * rejected.
 *
 * Anything else — a truncated link, a hand-typed value, a future rename read by
 * an old tab — falls back to `undefined`, which reads as "no opinion" and lets
 * the route/agent default decide. A panel hint must never be able to take the
 * page down.
 */
import { z } from "zod";

/**
 * Parses to `boolean | undefined`, so every reader downstream sees the one
 * shape. TanStack JSON-parses search values before validation, which is why the
 * legacy closed sentinel arrives as the number `0` rather than `"0"`.
 */
export const sidePanelSearchSchema = z
  .union([z.boolean(), z.literal("chat"), z.literal(0)])
  .optional()
  .transform((value) =>
    value === undefined ? undefined : value === true || value === "chat",
  )
  .catch(undefined);

/**
 * Whether the main panel is open. Absent = the route/agent default, which opens
 * it whenever the URL names a view. Never written by the app when it agrees
 * with that default, so a plain `/$org/agents/vir_x/preview` stays clean.
 */
export const mainPanelSearchSchema = z.boolean().optional().catch(undefined);
