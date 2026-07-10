import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { PublicConfig } from "@/api/routes/public-config";
import { KEYS } from "@/web/lib/query-keys";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// A rolling deploy always has old and new pods answering simultaneously for a
// stretch (inherent to maxSurge/maxUnavailable, not fully eliminable by the
// LB or nginx alone) — this app redeploys ~12x/day, so it's often mid-rollout.
// A single poll can catch that transient window and misreport drift; the
// user could then be stuck refreshing into a still-old pod until the rollout
// actually finishes, with no way to tell the difference. Requiring the SAME
// newer version on two consecutive polls (~5-10 min apart) means we only nag
// once the deploy has actually settled everywhere.
const CONFIRMATIONS_REQUIRED = 2;

type Drift = { version: string | null; count: number };

export function nextDrift(
  prev: Drift,
  serverVersion: string | undefined,
  clientVersion: string,
): Drift {
  if (!serverVersion || serverVersion === clientVersion) {
    return { version: null, count: 0 };
  }
  return prev.version === serverVersion
    ? { version: serverVersion, count: prev.count + 1 }
    : { version: serverVersion, count: 1 };
}

/**
 * Polls /api/config on its own (short-lived, unlike the Infinity-staleTime
 * publicConfig query used for boot) and prompts a refresh once the deployed
 * server version drifts — consistently, across repeated polls — from this
 * bundle's build-time __MESH_VERSION__.
 */
export function VersionCheckDialog() {
  const { data: serverVersion, dataUpdatedAt } = useQuery({
    queryKey: KEYS.appVersionCheck(),
    queryFn: async () => {
      const response = await fetch("/api/config");
      const { config }: { config: PublicConfig } = await response.json();
      return config.version;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  // `data` alone can stay referentially/value-equal across polls (same
  // version reported twice), which wouldn't re-render under tracked-property
  // optimization — dataUpdatedAt changes on every settled fetch, so tracking
  // it here is what lets us actually see each poll, not just each change.
  const [lastCheckedAt, setLastCheckedAt] = useState(0);
  const [drift, setDrift] = useState<Drift>({ version: null, count: 0 });

  if (dataUpdatedAt !== lastCheckedAt) {
    setLastCheckedAt(dataUpdatedAt);
    setDrift((prev) => nextDrift(prev, serverVersion, __MESH_VERSION__));
  }

  const isStale = drift.count >= CONFIRMATIONS_REQUIRED;

  return (
    <AlertDialog open={isStale}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>A new version is available</AlertDialogTitle>
          <AlertDialogDescription>
            You're viewing an outdated version of this page. Refresh to get the
            latest updates.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => window.location.reload()}>
            Refresh
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
