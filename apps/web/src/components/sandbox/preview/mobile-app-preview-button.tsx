import { useState } from "react";
import { QrCode02 } from "@untitledui/icons";
import { QRCodeSVG } from "qrcode.react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  draftSlug,
  isAppProtocol,
  mobileAppLink,
  openAppUrl,
  type MobileAppConfig,
} from "@decocms/shared/mobile-app";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { CopyValueButton } from "@/views/virtual-mcp/settings/copy-value-button";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { useT } from "@/i18n/use-t.ts";

/**
 * "View on phone" on a mobile-app project: a QR code of Studio's bridge
 * page (`/open-app`), which opens this canvas's draft and page in the app's
 * Dev build; the app link itself is there to copy. Highlighted (a pulse
 * and a standing tooltip) until it is opened once in this browser.
 */
export function MobileAppPreviewButton({
  virtualMcpId,
  config,
  draftPointer,
  path,
}: {
  virtualMcpId: string;
  config: MobileAppConfig;
  /** The canvas's v8 `__draft` pointer; null until the draft is read. */
  draftPointer: string | null;
  /** The page the canvas shows. */
  path: string;
}) {
  const t = useT();
  const [seen, setSeen] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.mobileAppQrSeen(virtualMcpId),
    (existing) => existing === true,
  );
  const [hovered, setHovered] = useState(false);
  const label = t("sandbox.preview.mobileApp.button");
  const hasProtocol = isAppProtocol(config.protocol);
  const slug = draftSlug(draftPointer);
  const params =
    hasProtocol && slug
      ? {
          protocol: config.protocol,
          slug,
          path,
          ios: config.iosInstallUrl,
          apk: config.androidInstallUrl,
        }
      : null;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open && !seen) setSeen(true);
      }}
    >
      <Tooltip open={!seen || hovered} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ToolbarIconButton
              aria-label={label}
              data-testid="mobile-app-qr-trigger"
            >
              {!seen && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-brand motion-safe:animate-ping"
                />
              )}
              <QrCode02 size={16} />
            </ToolbarIconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {seen ? label : t("sandbox.preview.mobileApp.new")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="flex w-72 flex-col items-center gap-3 p-4"
        align="center"
        sideOffset={8}
        data-testid="mobile-app-qr"
      >
        <h3 className="self-start text-sm font-medium">{label}</h3>
        {!hasProtocol ? (
          <p className="text-xs text-muted-foreground">
            {t("sandbox.preview.mobileApp.noProtocol")}
          </p>
        ) : !params ? (
          <p className="text-xs text-muted-foreground">
            {t("sandbox.preview.mobileApp.waiting")}
          </p>
        ) : (
          <>
            {/* Always dark on white: phone cameras read it in either theme. */}
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG
                value={openAppUrl(window.location.origin, params)}
                size={176}
              />
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {t("sandbox.preview.mobileApp.instruction")}
            </p>
            <div className="flex w-full items-center gap-1 rounded-md border bg-muted/40 pl-2">
              <code
                className="min-w-0 flex-1 truncate text-2xs"
                title={mobileAppLink(params)}
              >
                {mobileAppLink(params)}
              </code>
              <CopyValueButton
                value={mobileAppLink(params)}
                label={t("common.copy")}
                copiedLabel={t("sandbox.preview.mobileApp.copied")}
              />
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
