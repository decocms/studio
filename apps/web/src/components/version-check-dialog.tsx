import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { RefreshCw01 } from "@untitledui/icons";
import type { PublicConfig } from "@decocms/shared/config";
import { AnnouncementCard } from "@/components/announcement-card";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";

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
 * bundle's build-time __STUDIO_VERSION__.
 *
 * Dual-purpose by design. In the browser, the server IS the truth and
 * "Refresh now" reloads the newly deployed bundle. In the desktop app the
 * Rust proxy pins config.version to the embedded bundle's version, so drift
 * only ever appears when the shell's background updater has INSTALLED a new
 * version on disk — a webview reload can't pick that up (the running binary
 * serves its own embedded assets), so the button instead POSTs the local
 * restart route, which applies the staged update through the graceful
 * shutdown pipeline. A 409 means the staged state moved since the last poll
 * (e.g. a newer update superseded it mid-download): re-enable the button and
 * let the next poll re-converge — fetch resolves on 409, so the reset lives
 * in the !res.ok throw, not in catch alone.
 */
export function VersionCheckDialog() {
  const t = useT();
  const isDesktopApp = useIsDesktopApp();
  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/_local/update/restart", { method: "POST" });
      if (!res.ok) {
        throw new Error(`restart failed: ${res.status}`);
      }
      // 202 accepted: the app window is about to close and relaunch on the
      // new version — leave the button disabled for the page's short rest.
    },
  });
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
    setDrift((prev) => nextDrift(prev, serverVersion, __STUDIO_VERSION__));
  }

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // Locked through SUCCESS, not just isPending: after the 202 the app drains,
  // applies the staged update, and relaunches — a few seconds during which
  // this page is already dying. Re-enabling on success would offer a second
  // click to a doomed window. Only an error (409 staged-state race, network
  // blip) re-enables, letting the next poll re-converge the card.
  const restarting =
    isDesktopApp && (restartMutation.isPending || restartMutation.isSuccess);
  const handleAction = () =>
    isDesktopApp ? restartMutation.mutate() : window.location.reload();
  const actionLabelKey = isDesktopApp
    ? restarting
      ? "announcements.version.restarting"
      : "announcements.version.restart"
    : ("announcements.version.refresh" as const);

  if (!shouldShowVersionAnnouncement(drift, dismissedVersion)) return null;

  return (
    <AnnouncementCard
      ariaLabel={t("announcements.version.ariaLabel")}
      dismissLabel={t("announcements.version.dismiss")}
      eyebrow={t("announcements.version.eyebrow")}
      title={t("announcements.version.title")}
      description={t(
        isDesktopApp
          ? "announcements.version.descriptionNative"
          : "announcements.version.description",
      )}
      icon={<RefreshCw01 size={16} />}
      tone="system"
      onDismiss={() => setDismissedVersion(drift.version)}
      footerLeading={t("announcements.version.currentSession", {
        version: __STUDIO_VERSION__,
      })}
      actions={
        <Button size="sm" disabled={restarting} onClick={handleAction}>
          {t(actionLabelKey)}
          <RefreshCw01 size={14} className={cn(restarting && "animate-spin")} />
        </Button>
      }
    />
  );
}
