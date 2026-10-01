import { useState } from "react";
import QRCode from "react-qr-code";
import { QrCode02 } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useT } from "@/i18n/use-t.ts";
import {
  type PreviewDeviceHint,
  usePreviewDeviceHint,
} from "../preview-device-hint";

/**
 * "View on phone" for app preview servers (`kind: "eitri-app"`): the single
 * Eitri Play QR of the `eitri app start` the server follows (its build already
 * receives this tab's edits), or how to start one. The store app has no
 * preview mode, so there is no store QR.
 */
export function AppPreviewButton({
  hint: cachedHint,
  hintBase,
}: {
  hint: PreviewDeviceHint | null;
  /** Server the hint came from; re-read while the dialog is open. */
  hintBase: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // While open, poll so the sign-in link and then the QR show up by themselves.
  const hint = usePreviewDeviceHint(hintBase, open) ?? cachedHint;
  if (hint?.kind !== "eitri-app") return null;
  const status = hint.eitriPlay ? "qr" : hint.eitriLogin ? "login" : "waiting";
  const label = t("sandbox.preview.appPreview.button");
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton onClick={() => setOpen(true)} aria-label={label}>
            <QrCode02 size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {t(
                status === "qr"
                  ? "sandbox.preview.appPreview.eitriPlayDescription"
                  : status === "login"
                    ? "sandbox.preview.appPreview.eitriLoginDescription"
                    : "sandbox.preview.appPreview.noEitriPlay",
              )}
            </DialogDescription>
          </DialogHeader>
          {hint.eitriPlay ? (
            <div className="flex min-w-0 flex-col items-center gap-3">
              {/* QR codes need a light quiet zone to scan, in either theme. */}
              <div className="rounded-md bg-white p-3">
                <QRCode value={hint.eitriPlay} size={176} />
              </div>
              <p className="w-full text-xs text-muted-foreground">
                {t("sandbox.preview.appPreview.eitriPlayTrouble")}
              </p>
            </div>
          ) : status === "login" ? (
            <a
              href={hint.eitriLogin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              {t("sandbox.preview.appPreview.eitriLogin")}
            </a>
          ) : (
            <code className="rounded-md bg-muted px-3 py-2 text-sm">
              eitri app start -p
            </code>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
