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
 * "View on phone" for app projects (`kind: "eitri-app"`). With the app's
 * preview link (`.deco/app.json` `previewLink`, already filled with this
 * branch's draft pointer) the QR is there at once and opens the draft in the
 * store's dev app. Otherwise it falls back to the Eitri Play QR of an
 * `eitri app start` running next to the preview server (sandbox / Local).
 * The store app itself has no preview mode.
 */
export function AppPreviewButton({
  hint: cachedHint,
  hintBase,
  previewLink,
  isApp,
}: {
  hint: PreviewDeviceHint | null;
  /** Server the hint came from; re-read while the dialog is open. */
  hintBase: string | null;
  previewLink: string | null;
  /** The project renders an app (hint, build, or remembered from an earlier hint). */
  isApp: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // While open, poll so the sign-in link and then the QR show up by themselves.
  const hint =
    usePreviewDeviceHint(previewLink ? null : hintBase, open) ?? cachedHint;
  if (!previewLink && !isApp && hint?.kind !== "eitri-app") return null;
  const qr = previewLink ?? hint?.eitriPlay;
  const status = previewLink
    ? "link"
    : hint?.eitriPlay
      ? "qr"
      : hint?.eitriLogin
        ? "login"
        : "waiting";
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
                status === "link"
                  ? "sandbox.preview.appPreview.previewLinkDescription"
                  : status === "qr"
                    ? "sandbox.preview.appPreview.eitriPlayDescription"
                    : status === "login"
                      ? "sandbox.preview.appPreview.eitriLoginDescription"
                      : "sandbox.preview.appPreview.noEitriPlay",
              )}
            </DialogDescription>
          </DialogHeader>
          {qr ? (
            <div className="flex min-w-0 flex-col items-center gap-3">
              {/* QR codes need a light quiet zone to scan, in either theme. */}
              <div className="rounded-md bg-white p-3">
                <QRCode value={qr} size={208} />
              </div>
              <p className="w-full text-xs text-muted-foreground">
                {t(
                  status === "link"
                    ? "sandbox.preview.appPreview.previewLinkTrouble"
                    : "sandbox.preview.appPreview.eitriPlayTrouble",
                )}
              </p>
            </div>
          ) : status === "login" ? (
            <a
              href={hint?.eitriLogin}
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
