import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import QRCode from "react-qr-code";
import { Copy01, QrCode02 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { createOverlaySync, type Decofile } from "./overlay-sync";
import {
  AppPreviewError,
  createSession,
  endSession,
  getSession,
  isSessionGone,
  newPairing,
  patchOverlay,
  type AppPreviewPairing,
  type AppPreviewScope,
} from "./app-preview-session";

interface AppPreviewButtonProps {
  org: string;
  virtualMcpId: string;
  branch: string | null | undefined;
  /** The editor's current decofile, unsaved edits included. */
  decofile: Decofile | undefined;
}

/** "View on phone": pairs a device with this tab and streams its edits. */
export function AppPreviewButton(props: AppPreviewButtonProps) {
  const enabled = useOrgFlag("app_content_delivery");
  if (!enabled || !props.branch) return null;
  // A session belongs to one branch: switching remounts, ending the old one.
  return (
    <AppPreviewControl
      key={`${props.virtualMcpId}/${props.branch}`}
      {...props}
      branch={props.branch}
    />
  );
}

type Session = AppPreviewPairing & { devicesAtIssue: number };

function AppPreviewControl({
  org,
  virtualMcpId,
  branch,
  decofile,
}: AppPreviewButtonProps & { branch: string }) {
  const t = useT();
  const scope: AppPreviewScope = { org, virtualMcpId };
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [ended, setEnded] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [sync] = useState(() => createOverlaySync());

  const markEnded = () => {
    sync.stop();
    setSession(null);
    setEnded(true);
  };

  const create = useMutation({
    mutationFn: (_baseline: Decofile) => createSession(scope, branch),
    onSuccess: (pairing, baseline) => {
      setEnded(false);
      setOverlayError(null);
      setSession({ ...pairing, devicesAtIssue: 0 });
      sync.start(
        baseline,
        async (patch) => {
          await patchOverlay(scope, pairing.id, patch);
          setOverlayError(null);
        },
        (error) => {
          if (isSessionGone(error)) return markEnded();
          setOverlayError(
            error instanceof AppPreviewError && error.status === 413
              ? t("sandbox.preview.appPreview.tooLarge")
              : t("sandbox.preview.appPreview.syncFailed"),
          );
        },
      );
    },
  });

  const pairing = useMutation({
    mutationFn: (_devices: number) => newPairing(scope, session!.id),
    onSuccess: (next, devices) =>
      setSession({ ...next, devicesAtIssue: devices }),
    onError: (error) => {
      if (isSessionGone(error)) markEnded();
    },
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- network side effect: push each editor change to the paired phone
  useEffect(() => {
    if (decofile) sync.update(decofile);
  }, [decofile, sync]);

  const sessionId = session?.id;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- leaving the preview stops broadcasting and revokes the session
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      sync.stop();
      endSession({ org, virtualMcpId }, sessionId);
    };
  }, [sessionId, sync, org, virtualMcpId]);

  const start = () => {
    if (decofile && !create.isPending) create.mutate(decofile);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            active={!!session}
            disabled={!decofile}
            onClick={() => {
              setOpen(true);
              if (!session) start();
            }}
            aria-label={t("sandbox.preview.appPreview.button")}
          >
            <QrCode02 size={16} />
            {session && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-success" />
            )}
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent>
          {t("sandbox.preview.appPreview.button")}
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("sandbox.preview.appPreview.button")}</DialogTitle>
            <DialogDescription>
              {t("sandbox.preview.appPreview.description")}
            </DialogDescription>
          </DialogHeader>
          {session ? (
            <SessionPanel
              scope={scope}
              session={session}
              overlayError={overlayError}
              onGone={markEnded}
              refreshing={pairing.isPending}
              onRefresh={(devices) => pairing.mutate(devices)}
            />
          ) : create.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {create.error
                ? t(
                    create.error instanceof AppPreviewError &&
                      create.error.status === 404
                      ? "sandbox.preview.appPreview.unavailable"
                      : "sandbox.preview.appPreview.createFailed",
                  )
                : ended
                  ? t("sandbox.preview.appPreview.ended")
                  : null}
            </p>
          )}
          <DialogFooter>
            {session ? (
              <Button
                variant="destructive"
                onClick={() => {
                  setSession(null);
                  setOpen(false);
                }}
              >
                {t("sandbox.preview.appPreview.end")}
              </Button>
            ) : (
              !create.isPending && (
                <Button onClick={start} disabled={!decofile}>
                  {t("sandbox.preview.appPreview.newQr")}
                </Button>
              )
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function subscribeClock(onTick: () => void) {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function SessionPanel({
  scope,
  session,
  overlayError,
  onGone,
  refreshing,
  onRefresh,
}: {
  scope: AppPreviewScope;
  session: Session;
  overlayError: string | null;
  onGone: () => void;
  refreshing: boolean;
  /** Issues a new code; `devices` is the count it was issued at. */
  onRefresh: (devices: number) => void;
}) {
  const t = useT();
  const now = useSyncExternalStore(subscribeClock, nowSeconds);
  const pairingExpiresAt = Math.floor(
    Date.parse(session.pairingExpiresAt) / 1000,
  );
  // Mounted only while the dialog is open, so it polls only then.
  const state = useQuery({
    queryKey: KEYS.appPreviewSession(scope.org, scope.virtualMcpId, session.id),
    refetchInterval: 3000,
    retry: false,
    queryFn: async () => {
      const current = await getSession(scope, session.id).catch((error) => {
        if (isSessionGone(error)) onGone();
        throw error;
      });
      if (current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) {
        onGone();
        return current;
      }
      // A claimed or expired code is dead: keep a scannable one on screen.
      const consumed = current.devices.length > session.devicesAtIssue;
      const expired = Date.parse(session.pairingExpiresAt) <= Date.now();
      if ((consumed || expired) && !refreshing) {
        onRefresh(current.devices.length);
      }
      return current;
    },
  });
  const devices = state.data?.devices.length ?? 0;
  const remaining = Math.max(0, pairingExpiresAt - now);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(session.pairingCode);
      toast.success(t("sandbox.preview.appPreview.copied"));
    } catch {
      toast.error(t("sandbox.preview.appPreview.copyFailed"));
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-center gap-3">
      {/* QR codes need a light quiet zone to scan, in either theme. */}
      <div className="rounded-md bg-white p-3">
        <QRCode value={session.link ?? session.pairingCode} size={176} />
      </div>
      <div className="flex w-full flex-col gap-1">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("sandbox.preview.appPreview.codeLabel")}
        </span>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
            {session.pairingCode}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyCode()}
            aria-label={t("sandbox.preview.appPreview.copy")}
          >
            <Copy01 size={13} />
          </Button>
        </div>
      </div>
      <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
        <span>
          {t("sandbox.preview.appPreview.expiresIn", {
            time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
          })}
        </span>
        <span>
          {t("sandbox.preview.appPreview.devices", { count: devices })}
        </span>
      </div>
      {overlayError && (
        <p className="w-full text-xs text-destructive">{overlayError}</p>
      )}
      <Button
        className="w-full"
        variant="outline"
        disabled={refreshing}
        onClick={() => onRefresh(devices)}
      >
        {t("sandbox.preview.appPreview.newQr")}
      </Button>
    </div>
  );
}
