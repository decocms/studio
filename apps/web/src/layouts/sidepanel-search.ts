/**
 * The `?sidepanel` search param, and the two shapes it used to have.
 *
 * It means one thing — is the chat side panel open — so it is a boolean, and
 * every writer in the app writes `true`/`false`. But the param shipped as
 * `?sidepanel=chat` / `?sidepanel=0` first, and those URLs are in bookmarks,
 * shared links and pasted messages that outlive the rename. A search schema
 * that throws on them is a full-page "Something went wrong" for a *layout*
 * hint, so the legacy pair is translated instead of rejected.
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
