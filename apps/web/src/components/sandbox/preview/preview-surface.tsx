import type { ReactNode } from "react";
import {
  Monitor04,
  Phone02,
  Tablet01,
  LinkExternal01,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useElementSize } from "@/hooks/use-element-size";
import { useT } from "@/i18n/use-t";
import { previewViewportLayout } from "./preview-viewport";
import type { PreviewDeviceSize } from "./device-hint";

export const PREVIEW_DEVICES: PreviewDeviceSize[] = [
  "desktop",
  "mobile",
  "tablet",
];
const DEVICE_LABELS = {
  desktop: "sandbox.preview.deviceDesktop",
  mobile: "sandbox.preview.deviceMobile",
  tablet: "sandbox.preview.deviceTablet",
} as const;

/** Navigation shared by CMS and deployed-URL previews. Hosts supply URL-specific controls. */
export function PreviewNavigation({
  device,
  onDeviceChange,
  urlControls,
  actions,
  onOpen,
  openDisabled,
}: {
  device: PreviewDeviceSize;
  onDeviceChange: (device: PreviewDeviceSize) => void;
  urlControls: ReactNode;
  actions?: ReactNode;
  onOpen: () => void;
  openDisabled?: boolean;
}) {
  const t = useT();
  const Icon =
    device === "mobile" ? Phone02 : device === "tablet" ? Tablet01 : Monitor04;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            onClick={() =>
              onDeviceChange(
                PREVIEW_DEVICES[
                  (PREVIEW_DEVICES.indexOf(device) + 1) % PREVIEW_DEVICES.length
                ]!,
              )
            }
            aria-label={t(DEVICE_LABELS[device])}
          >
            <Icon size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent>{t(DEVICE_LABELS[device])}</TooltipContent>
      </Tooltip>
      {urlControls}
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <ToolbarIconButton
          onClick={onOpen}
          disabled={openDisabled}
          aria-label={t("sandbox.preview.openInNewTab")}
        >
          <LinkExternal01 size={16} />
        </ToolbarIconButton>
      </div>
    </div>
  );
}

/** The same measured, scaled canvas for CMS editing and task review. */
export function PreviewCanvas({
  device,
  frame,
  children,
  onFrameMouseLeave,
}: {
  device: PreviewDeviceSize;
  frame?: ReactNode;
  children?: ReactNode;
  onFrameMouseLeave?: () => void;
}) {
  const [size, ref] = useElementSize();
  const { fluid, style } = previewViewportLayout(device, size);
  return (
    <div
      ref={ref}
      className={cn(
        "h-full relative overflow-clip flex justify-center",
        frame && !fluid && "bg-muted/30",
      )}
    >
      {children}
      {frame && (
        <div
          className={cn("shrink-0", !fluid && "bg-background shadow-edge")}
          style={style}
          onMouseLeave={onFrameMouseLeave}
        >
          {frame}
        </div>
      )}
    </div>
  );
}
