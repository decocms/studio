import type { ResolvedGitClient } from "@/git-providers/types";
import type { MeshContext } from "@/core/mesh-context";

/**
 * Append an attribution footer to GitHub write payloads when running as the
 * bot. Real-user calls get a clean payload (the user IS the GitHub author).
 *
 * The footer carries the Studio workflow / request id so that even though the
 * GitHub-visible author is "Decobot", the actual triggering source is
 * traceable from the GitHub artifact back to Studio's audit log.
 */
export function withBotFooter(
  body: string | undefined | null,
  client: ResolvedGitClient,
  ctx: MeshContext,
): string {
  const base = (body ?? "").trim();
  if (client.actor === "user") return base;
  const requestId = ctx.metadata.requestId;
  const footer = `\n\n---\n_via Decobot — triggered by Studio request \`${requestId}\`_`;
  return base ? `${base}${footer}` : `_via Decobot_`;
}
