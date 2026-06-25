import { useState } from "react";
import {
  EyeOff,
  LayoutAlt01,
  LinkExternal01,
  Monitor04,
  Phone02,
  RefreshCw01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  buildGlobalSectionPreviewUrl,
  buildInlineSectionPreviewUrl,
} from "@/web/components/sections-editor/section-preview-url";

export type SectionPreviewTarget =
  | { kind: "saved"; blockKey: string }
  | { kind: "inline"; resolveType: string; data: Record<string, unknown> };

type PreviewDevice = "desktop" | "mobile";

const MOBILE_WIDTH_PX = 375;

function withDeviceHint(url: string, device: PreviewDevice): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("deviceHint", device);
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Live preview of a single CMS section, rendered in a sandboxed iframe that
 * points at the sandbox dev server's `/live/previews/<page>` endpoint (same
 * mechanism as the section gallery and the interactive Preview tab). Bumping
 * `reloadKey` recomputes the URL (with a fresh cache-bust) so the iframe reloads
 * after an autosave or when the preview is (re)opened for an inline edit.
 */
export function SectionPreviewPane({
  previewUrl,
  livePageResolveType,
  target,
  theme,
  reloadKey,
  onHide,
  onRefresh,
}: {
  previewUrl: string | null;
  livePageResolveType: string;
  target: SectionPreviewTarget;
  theme?: Record<string, unknown>;
  reloadKey: number;
  /** Renders a "hide preview" button in the toolbar when provided. */
  onHide?: () => void;
  /** Renders a manual "refresh" button when provided (inline edits). */
  onRefresh?: () => void;
}) {
  const [device, setDevice] = useState<PreviewDevice>("desktop");

  const targetId =
    target.kind === "saved" ? target.blockKey : target.resolveType;
  const depKey = `${previewUrl ?? ""}|${livePageResolveType}|${target.kind}|${targetId}|${reloadKey}`;

  // Derive the iframe src in state so it changes ONLY when an input changes
  // (recomputing inline would mint a new cache-bust on every render, reloading
  // the iframe constantly). For inline targets the latest form data is read at
  // recompute time, so a `reloadKey` bump captures the current edits.
  const [src, setSrc] = useState<string | null>(null);
  const [prevDepKey, setPrevDepKey] = useState<string | null>(null);
  if (prevDepKey !== depKey) {
    setPrevDepKey(depKey);
    if (!previewUrl || !livePageResolveType) {
      setSrc(null);
    } else if (target.kind === "saved") {
      setSrc(
        buildGlobalSectionPreviewUrl(
          previewUrl,
          livePageResolveType,
          target.blockKey,
        ),
      );
    } else {
      setSrc(
        buildInlineSectionPreviewUrl(
          previewUrl,
          livePageResolveType,
          target.resolveType,
          target.data,
          theme,
        ),
      );
    }
  }

  const deviceSrc = src ? withDeviceHint(src, device) : null;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-2">
        <span className="flex-1 pl-1 text-xs font-medium text-muted-foreground">
          Preview
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() =>
                setDevice((d) => (d === "desktop" ? "mobile" : "desktop"))
              }
              aria-label={
                device === "desktop"
                  ? "Switch to mobile preview"
                  : "Switch to desktop preview"
              }
            >
              {device === "desktop" ? (
                <Monitor04 size={14} />
              ) : (
                <Phone02 size={14} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {device === "desktop" ? "Desktop" : "Mobile (375px)"}
          </TooltipContent>
        </Tooltip>
        {onRefresh && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onRefresh}
                aria-label="Refresh preview"
              >
                <RefreshCw01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!deviceSrc}
              onClick={() => {
                if (deviceSrc) window.open(deviceSrc, "_blank", "noopener");
              }}
              aria-label="Open preview in new tab"
            >
              <LinkExternal01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in new tab</TooltipContent>
        </Tooltip>
        {onHide && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onHide}
                aria-label="Hide preview"
              >
                <EyeOff size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Hide preview</TooltipContent>
          </Tooltip>
        )}
      </div>

      {!deviceSrc ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <LayoutAlt01 size={24} className="text-muted-foreground/50" />
          <div>No preview available</div>
          <div className="max-w-xs text-xs text-muted-foreground/80">
            Start the preview dev server to see this section rendered.
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "min-h-0 flex-1",
            device === "mobile" && "flex justify-center bg-muted/30 py-3",
          )}
        >
          <iframe
            key={deviceSrc}
            src={deviceSrc}
            title="Section preview"
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            className={cn(
              "h-full border-0 bg-white",
              device === "mobile"
                ? "w-full max-w-full border-x shadow-sm"
                : "w-full",
            )}
            style={
              device === "mobile"
                ? { width: `${MOBILE_WIDTH_PX}px` }
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
