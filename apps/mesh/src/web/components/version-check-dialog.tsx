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
import type { PublicConfig } from "@/api/routes/public-config";
import { KEYS } from "@/web/lib/query-keys";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Polls /api/config on its own (short-lived, unlike the Infinity-staleTime
 * publicConfig query used for boot) and prompts a refresh once the deployed
 * server version drifts from this bundle's build-time __MESH_VERSION__.
 */
export function VersionCheckDialog() {
  const { data: serverVersion } = useQuery({
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

  const isStale = !!serverVersion && serverVersion !== __MESH_VERSION__;

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
