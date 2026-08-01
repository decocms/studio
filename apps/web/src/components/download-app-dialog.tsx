import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Check, Copy01, Download01 } from "@untitledui/icons";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";

const RELEASES_URL = "https://github.com/decocms/studio/releases";

// The install script is served by this same deployment
// (apps/web/public/install.sh), so the command stays correct on any host —
// studio.decocms.com or a self-hosted instance.
function installCommand(): string {
  return `curl -fsSL ${window.location.origin}/install.sh | sh`;
}

// Pinned to the immutable `native-v<version>` release rather than
// `releases/latest/download`: other workflows publish releases in this repo, so
// "latest" is not guaranteed to be a native tag. The asset name is a contract
// shared with the release workflow and the updater manifest's PLATFORM_ASSETS.
export function appImageDownloadUrl(version: string): string {
  return `https://github.com/decocms/studio/releases/download/native-v${version}/deco-${version}-linux-x86_64.AppImage`;
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

// Android reports a "Linux …" platform, so it has to be excluded explicitly;
// the touch exclusion mirrors the mac gate so the two age together. ChromeOS
// also matches and is offered an AppImage (Crostini can run it) — accepted
// for v1.
export function isLinuxDesktopBrowser(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Linux/.test(navigator.platform) &&
    !/Android/.test(navigator.userAgent) &&
    !("ontouchend" in document)
  );
}

interface DownloadAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Clipboard write can reject or be entirely absent (denied permission, or a
// non-HTTPS self-hosted origin — this dialog explicitly supports self-hosting).
// Resolves to whether the copy actually happened, so callers never see an
// unhandled rejection or a TypeError from calling into a missing API.
export async function copyToClipboard(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MacInstall() {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const command = installCommand();

  return (
    <>
      <div className="flex flex-col gap-3">
        <code className="block rounded-md border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
          {command}
        </code>
        <Button
          type="button"
          className="w-full gap-2"
          onClick={() => {
            copyToClipboard(navigator.clipboard, command).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check size={16} /> : <Copy01 size={16} />}
          {copied ? t("downloadApp.copiedLabel") : t("downloadApp.copyLabel")}
        </Button>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{t("downloadApp.terminalHint")}</p>
        <p>{t("downloadApp.appleSiliconNote")}</p>
      </div>
    </>
  );
}

function LinuxInstall() {
  const t = useT();

  return (
    <>
      <Button asChild className="w-full gap-2">
        <a href={appImageDownloadUrl(__STUDIO_VERSION__)} rel="noreferrer">
          <Download01 size={16} />
          {t("downloadApp.downloadAppImage")}
        </a>
      </Button>

      <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
        <p>{t("downloadApp.linuxChmodHint")}</p>
        <p>{t("downloadApp.linuxArchNote")}</p>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("downloadApp.allReleases")}
        </a>
      </div>
    </>
  );
}

export function DownloadAppDialog({
  open,
  onOpenChange,
}: DownloadAppDialogProps) {
  const t = useT();
  // The whole dialog branches, not just its body: the shared description names
  // the Mac's Terminal, which must never appear above an AppImage download.
  const linux = isLinuxDesktopBrowser();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("downloadApp.title")}</DialogTitle>
          <DialogDescription>
            {linux
              ? t("downloadApp.linuxDescription")
              : t("downloadApp.description")}
          </DialogDescription>
        </DialogHeader>

        {linux ? <LinuxInstall /> : <MacInstall />}
      </DialogContent>
    </Dialog>
  );
}
