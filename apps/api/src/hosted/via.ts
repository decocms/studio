/**
 * How a draft or a revision was made (`via`), set by the server from the
 * auth method and never taken from the request (contract §4.2):
 *
 *   browser session                          studio
 *   MCP OAuth (the Studio CLI's login)       cli
 *   API key                                  token
 *   studio JWT, or an on-behalf-of key       studio-agent
 */

import type { StudioContext } from "@/core/studio-context";
import type { CmsVia } from "@/storage/types";

export function viaOf(
  auth: Pick<StudioContext["auth"], "method" | "onBehalfOf">,
): CmsVia {
  switch (auth.method) {
    case "mcpOAuth":
      return "cli";
    case "apiKey":
      return auth.onBehalfOf ? "studio-agent" : "token";
    case "studioJwt":
      return "studio-agent";
    default:
      return "studio";
  }
}
