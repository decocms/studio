/**
 * Connecting a channel, the token it gets (shown once), and the two things
 * that can't be undone: rotating that token and deleting the connection.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "@untitledui/icons";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { toast } from "@decocms/ui/components/sonner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { CopySnippet } from "@/components/connect/copy-snippet.tsx";
import { useT } from "@/i18n/use-t.ts";
import { channelName } from "@/lib/channel-accounts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { ChannelMark } from "./channel-mark.tsx";

export type Connection =
  StudioToolIO["CHANNELS_CONNECTION_LIST"]["output"]["connections"][number];

/** What the token dialog shows: the token, and the connection it opens. */
export interface Secret {
  token: string;
  connectionId: string;
  name: string;
  /** A new connection, or a new token for one that was there. */
  rotated: boolean;
}

/** CHANNELS_CONNECTION_CREATE's sources, in the order the picker offers them. */
const SOURCES = [
  "whatsapp",
  "discord",
  "slack",
  "gchat",
  "grain",
  "teams",
] as const;
type Source = (typeof SOURCES)[number];

export const connectionLabel = (c: Connection) => c.name ?? c.external_id;

/** Where a connection's worker posts its events, by the org's id. */
export const ingestUrl = (orgId: string, connectionId: string) =>
  `${window.location.origin}/api/${orgId}/channels/connections/${connectionId}/events`;

export function ConnectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (secret: Secret) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("whatsapp");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () =>
      studio.call("CHANNELS_CONNECTION_CREATE", {
        source,
        external_id: externalId.trim(),
        name: name.trim() || undefined,
      }),
    onSuccess: async ({ connection, token }) => {
      setExternalId("");
      setName("");
      onCreated({
        token,
        connectionId: connection.id,
        name: connectionLabel(connection),
        rotated: false,
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.channelsConnections(org.id),
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) create.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (externalId.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("channels.form.title")}</DialogTitle>
            <DialogDescription>
              {t("channels.form.description")}
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              {t("channels.form.source")}
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SOURCES.map((s) => (
                <label
                  key={s}
                  className={cn(
                    "focus-within-ring flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                    source === s
                      ? "border-foreground/40 bg-accent font-medium"
                      : "hover:bg-accent/50",
                  )}
                >
                  <input
                    type="radio"
                    name="channel-source"
                    value={s}
                    checked={source === s}
                    onChange={() => setSource(s)}
                    className="sr-only"
                  />
                  <ChannelMark source={s} className="size-6" />
                  <span className="truncate">{channelName(s)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-external-id">
              {t("channels.form.externalId")}
            </Label>
            <Input
              id="channel-external-id"
              required
              maxLength={512}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("channels.form.externalIdHint")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">{t("channels.form.name")}</Label>
            <Input
              id="channel-name"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {create.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              variant="brand"
              disabled={!externalId.trim() || create.isPending}
            >
              {create.isPending
                ? t("channels.form.submitting")
                : t("channels.form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ingestion token, shown once: closing the dialog drops it. With it, the
 * address the worker posts to, so the two travel together.
 */
export function TokenOnceDialog({
  secret,
  onClose,
}: {
  secret: Secret | null;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {secret?.rotated
              ? t("channels.token.rotatedTitle", { name: secret.name })
              : t("channels.token.title", { name: secret?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t("channels.token.description")}
          </DialogDescription>
        </DialogHeader>
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>{t("channels.token.once")}</AlertDescription>
        </Alert>
        {secret && (
          <div className="flex flex-col divide-y rounded-lg border">
            <CopySnippet
              label={t("channels.token.token")}
              code={secret.token}
            />
            <CopySnippet
              label={t("channels.token.endpoint")}
              code={ingestUrl(org.id, secret.connectionId)}
            />
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>{t("channels.token.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rotate or delete, asked first. Rotating hands the new token to `onToken`;
 * deleting drops everything under the org's channels key and calls
 * `onDeleted` (the screen leaves a connection that is gone).
 */
export function ConnectionConfirm({
  action,
  connection,
  onClose,
  onToken,
  onDeleted,
}: {
  action: "rotate" | "delete" | null;
  connection: Connection | null;
  onClose: () => void;
  onToken: (secret: Secret) => void;
  onDeleted?: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const name = connection ? connectionLabel(connection) : "";

  const rotate = useMutation({
    mutationFn: (id: string) =>
      studio.call("CHANNELS_CONNECTION_ROTATE_TOKEN", { id }),
    onSuccess: ({ token }, id) =>
      onToken({ token, connectionId: id, name, rotated: true }),
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("CHANNELS_CONNECTION_DELETE", { id }),
    onSuccess: async () => {
      onDeleted?.();
      await queryClient.invalidateQueries({ queryKey: KEYS.channels(org.id) });
      toast.success(t("channels.deleted"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <AlertDialog open={action !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {action === "delete"
              ? t("channels.delete.title", { name })
              : t("channels.rotate.title", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {action === "delete"
              ? t("channels.delete.description")
              : t("channels.rotate.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("channels.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant={action === "delete" ? "destructive" : "default"}
            onClick={() => {
              if (!connection) return;
              if (action === "delete") remove.mutate(connection.id);
              else rotate.mutate(connection.id);
            }}
          >
            {action === "delete"
              ? t("channels.delete")
              : t("channels.rotateToken")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
