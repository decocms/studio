import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";

// The install script is served by this same deployment
// (apps/web/public/install.sh), so the command stays correct on any host —
// studio.decocms.com or a self-hosted instance.
function installCommand(): string {
  return `curl -fsSL ${window.location.origin}/install.sh | sh`;
}

// Deliberately narrower than keyboard-shortcuts' isMac, which also matches
// iPhone/iPad (and iPadOS reports "Macintosh"): touch devices can't run the
// terminal installer, so they must not be offered the download.
export function isMacDesktopBrowser(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac/.test(navigator.platform) &&
    !("ontouchend" in document)
  );
}

interface DownloadAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DownloadAppDialog({
  open,
  onOpenChange,
}: DownloadAppDialogProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const command = installCommand();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("downloadApp.title")}</DialogTitle>
          <DialogDescription>{t("downloadApp.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
          <span className="flex-1 truncate">{command}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("downloadApp.copyLabel")}
            onClick={() => {
              navigator.clipboard.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={14} /> : <Copy01 size={14} />}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("downloadApp.appleSiliconNote")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
