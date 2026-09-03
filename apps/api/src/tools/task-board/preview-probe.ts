import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { isTrustedPreviewHost } from "./prs-get";

/**
 * Is a PR's deploy preview actually up?
 *
 * A preview is often still building — or already torn down — while the PR card
 * happily offers an "Open preview" button that lands the user on a 404. The
 * card wants to know before it enables the button.
 *
 * The browser can't answer that itself: a cross-origin `fetch` is blocked by
 * CORS, and `mode: "no-cors"` returns an opaque response whose status is 0 for
 * a 200 and a 500 alike. So the probe runs here, where the status is readable.
 *
 * Deliberately uncached — the whole question is "is it up right now", and a
 * cached "unavailable" would keep the button dead after the deploy finished.
 */

/** Preview hosts can be slow to wake, but the card is blocked on this — a probe
 *  that hangs is as useless as one that fails. */
const PROBE_TIMEOUT_MS = 8000;

export const TASK_BOARD_PREVIEW_PROBE = defineTool({
  name: "TASK_BOARD_PREVIEW_PROBE",
  description:
    "Check whether a PR's deploy preview URL is currently reachable, so the " +
    "UI can enable or block its 'Open preview' button.",
  annotations: {
    title: "Probe Deploy Preview",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: z.object({
    available: z.boolean(),
    /** The HTTP status when the host answered; null when it did not. */
    status: z.number().nullable(),
  }),
  handler: async ({ url }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    // This makes the server fetch a URL chosen by the caller, so it is gated on
    // the same allowlist that decides whether a preview may be SHOWN at all
    // (previews are lifted from PR comments, which outside contributors write).
    // Re-checked here rather than trusted from the card: the input is an
    // argument, not something the card proves it got from `prs-get`.
    if (!isTrustedPreviewHost(url)) {
      return { available: false, status: null };
    }

    try {
      const res = await fetch(url, {
        // GET, not HEAD: preview hosts answer 405 to HEAD often enough that the
        // probe would report a live preview as broken. `fetch` resolves at the
        // headers, and the body is cancelled below, so nothing is downloaded.
        method: "GET",
        // Never follow: a redirect is how a trusted host would be turned into a
        // request to somewhere that isn't one. A 3xx still means the preview is
        // answering, which is all the button needs to know.
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      return { available: res.status < 400, status: res.status };
    } catch {
      // DNS failure, TLS failure, timeout — no answer at all.
      return { available: false, status: null };
    }
  },
});
