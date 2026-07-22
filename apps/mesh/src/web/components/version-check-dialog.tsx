import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { RefreshCw01 } from "@untitledui/icons";
import type { PublicConfig } from "@/api/routes/public-config";
import { AnnouncementCard } from "@/web/components/announcement-card";
import { useT } from "@/web/i18n/use-t.ts";
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

export function shouldShowVersionAnnouncement(
  drift: Drift,
  dismissedVersion: string | null,
): boolean {
  return (
    drift.count >= CONFIRMATIONS_REQUIRED &&
    drift.version !== null &&
    drift.version !== dismissedVersion
  );
}

/**
 * Polls /api/config on its own (short-lived, unlike the Infinity-staleTime
 * publicConfig query used for boot) and prompts a refresh once the deployed
 * server version drifts — consistently, across repeated polls — from this
 * bundle's build-time __MESH_VERSION__.
 */
export function VersionCheckDialog() {
  const t = useT();
  const { data: serverVersion, dataUpdatedAt } = useQuery({
    queryKey: KEYS.appVersionCheck(),
    queryFn: async () => {
      // The server sends Cache-Control: no-store, but force it client-side
      // too — this poll is worthless if any layer serves a cached response.
      const response = await fetch("/api/config", { cache: "no-store" });
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

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (!shouldShowVersionAnnouncement(drift, dismissedVersion)) return null;

  return (
    <AnnouncementCard
      ariaLabel={t("announcements.version.ariaLabel")}
      dismissLabel={t("announcements.version.dismiss")}
      eyebrow={t("announcements.version.eyebrow")}
      title={t("announcements.version.title")}
      description={t("announcements.version.description")}
      icon={<RefreshCw01 size={16} />}
      tone="system"
      onDismiss={() => setDismissedVersion(drift.version)}
      footerLeading={t("announcements.version.currentSession", {
        version: __MESH_VERSION__,
      })}
      actions={
        <Button size="sm" onClick={() => window.location.reload()}>
          {t("announcements.version.refresh")}
          <RefreshCw01 size={14} />
        </Button>
      }
    />
  );
}
