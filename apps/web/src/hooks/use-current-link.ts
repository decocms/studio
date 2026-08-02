import { useQuery } from "@tanstack/react-query";
import type { Capability } from "@decocms/sandbox/dispatch";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { isDesktopAppEnvironment } from "./use-is-desktop-app";

/**
 * Which CLI harnesses this machine can run.
 *
 * NATIVE-ONLY, and NOT a Studio tool. `LINK_CURRENT_GET` used to be one, backed
 * by the desktop link daemon; that daemon is gone and so is the server-side
 * tool. What still answers this route is the Tauri app's Rust local-api, which
 * INTERCEPTS `POST /api/:org/tools/LINK_CURRENT_GET` and reports the harnesses
 * it probed on this machine — see
 * `apps/native/crates/local-api/src/routes/intercept/link_current.rs` (`online`
 * is unconditionally true there: the app running IS the local machine).
 *
 * Because the responder is the native app rather than the cluster, this calls
 * the route directly instead of going through `useStudioTools()` — the tool is
 * deliberately absent from `StudioToolIO`, and the shape below is the contract
 * with the Rust interceptor. On web the query never runs: there is no local
 * machine to probe and no server-side tool to reach.
 */
export interface CurrentLink {
  online: boolean;
  machineId?: string;
  hostname?: string;
  cliVersion?: string;
  capabilities: Capability[];
  /**
   * False until the probe has resolved at least once this mount. Lets "no local
   * CLI" surfaces hold back instead of flashing empty state during the fetch.
   */
  ready: boolean;
}

const OFFLINE: CurrentLink = { online: false, capabilities: [], ready: false };
/** Web's terminal state: resolved, and there is nothing to resolve to. */
const OFFLINE_RESOLVED: CurrentLink = { ...OFFLINE, ready: true };

export interface UseCurrentLinkOptions {
  /**
   * Poll faster while something is actively watching for a state change
   * (e.g. a dialog waiting on CLI detection). Everyone else gets the slow,
   * passive-display cadence.
   */
  fast?: boolean;
}

export function useCurrentLink(options?: UseCurrentLinkOptions): CurrentLink {
  const { org } = useProjectContext();
  const fast = options?.fast ?? false;
  const isDesktopApp = isDesktopAppEnvironment();

  const { data } = useQuery<CurrentLink>({
    enabled: isDesktopApp,
    queryKey: KEYS.currentLink(org.id),
    queryFn: async () => {
      const res = await fetch(
        `/api/${encodeURIComponent(org.slug)}/tools/LINK_CURRENT_GET`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!res.ok) return { ...OFFLINE, ready: true };
      const link = (await res.json()) as Omit<CurrentLink, "ready"> | null;
      return link ? { ...link, ready: true } : { ...OFFLINE, ready: true };
    },
    staleTime: fast ? 1_000 : 10_000,
    refetchInterval: fast ? 2_000 : 15_000,
    refetchOnWindowFocus: true,
  });

  if (!isDesktopApp) return OFFLINE_RESOLVED;
  return data ?? OFFLINE;
}
