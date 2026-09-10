/** Is the org shell showing its SETTINGS body?
 *
 *  One question, several askers — the sidebar (which body), the picker (a
 *  project scope means nothing in settings) and the Settings row (which target
 *  lights up) — so it is answered once, here.
 *
 *  It asks the ROUTER for the settings layout match rather than prefix-matching
 *  a pathname: `from` is typed against the route-id union, so renaming the
 *  settings layout is a compile error rather than a silently dead branch. The
 *  match commits in the same batch that swaps the inset, so the sidebar's body
 *  and the panel can never disagree for a frame. */

import { useMatch } from "@tanstack/react-router";

export function useInSettings(): boolean {
  return !!useMatch({ from: "/shell/$org/settings", shouldThrow: false });
}
