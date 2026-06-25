import { useEffect, useRef, useState } from "react";
import {
  Eye,
  LayoutAlt01,
  LinkExternal01,
  Monitor04,
  Phone02,
  RefreshCw01,
  XClose,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { MonacoCodeEditor } from "@/web/components/monaco-editor";
import {
  buildGlobalSectionPreviewUrl,
  buildInlineSectionPreviewUrl,
} from "@/web/components/sections-editor/section-preview-url";

export type SectionPreviewTarget =
  | { kind: "saved"; blockKey: string }
  | { kind: "inline"; resolveType: string; data: Record<string, unknown> };

type SidePanelTab = "preview" | "json";
type PreviewDevice = "desktop" | "mobile";

const MOBILE_WIDTH_PX = 375;
/** Debounce before applying valid JSON edits back to the section. */
const JSON_APPLY_DEBOUNCE_MS = 500;

function withDeviceHint(url: string, device: PreviewDevice): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("deviceHint", device);
    return parsed.href;
  } catch {
    return url;
  }
}

/** Curly-braces glyph (lucide "braces") — a real `{ }`, unlike the square brackets icon. */
function CurlyBracesIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" />
      <path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2" />
    </svg>
  );
}

function PreviewSurface({
  previewUrl,
  livePageResolveType,
  target,
  theme,
  reloadKey,
  device,
}: {
  previewUrl: string | null;
  livePageResolveType: string;
  target: SectionPreviewTarget;
  theme?: Record<string, unknown>;
  reloadKey: number;
  device: PreviewDevice;
}) {
  const targetId =
    target.kind === "saved" ? target.blockKey : target.resolveType;
  const depKey = `${previewUrl ?? ""}|${livePageResolveType}|${target.kind}|${targetId}|${reloadKey}`;

  // Derive the iframe src in state so it changes ONLY when an input changes —
  // recomputing inline would mint a fresh cache-bust every render. For inline
  // targets the latest form data is read at recompute time, so a reloadKey bump
  // captures the current edits.
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

  if (!deviceSrc) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <LayoutAlt01 size={24} className="text-muted-foreground/50" />
        <div>No preview available</div>
        <div className="max-w-xs text-xs text-muted-foreground/80">
          Start the preview dev server to see this section rendered.
        </div>
      </div>
    );
  }

  return (
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
          device === "mobile" ? { width: `${MOBILE_WIDTH_PX}px` } : undefined
        }
      />
    </div>
  );
}

/**
 * Collapsible right-side panel for a section: a live preview tab and an
 * editable JSON tab (Monaco). Opening the JSON tab seeds the editor from the
 * current `jsonValue`; valid edits are applied back via `onApplyJson` (debounced
 * while typing, immediately on Cmd/Ctrl+S). When collapsed, a thin icon rail
 * exposes both tabs.
 */
export function SectionSidePanel({
  previewUrl,
  livePageResolveType,
  previewTarget,
  theme,
  reloadKey,
  onRefreshPreview,
  jsonValue,
  onApplyJson,
  initialTab = null,
}: {
  previewUrl: string | null;
  livePageResolveType: string;
  previewTarget: SectionPreviewTarget;
  theme?: Record<string, unknown>;
  reloadKey: number;
  /** Manual preview refresh (inline edits). */
  onRefreshPreview?: () => void;
  /** Stringified current section data, used to seed the JSON editor on open. */
  jsonValue: string;
  /** Called with parsed data when the JSON editor holds valid JSON. */
  onApplyJson: (data: Record<string, unknown>) => void;
  initialTab?: SidePanelTab | null;
}) {
  const [tab, setTab] = useState<SidePanelTab | null>(initialTab);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup
  useEffect(() => {
    return () => {
      if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    };
  }, []);

  const openTab = (next: SidePanelTab) => {
    if (next === "json") {
      setJsonDraft(jsonValue);
      setJsonError(null);
    }
    setTab(next);
  };

  const buildOpenUrl = (): string | null => {
    if (!previewUrl || !livePageResolveType) return null;
    const base =
      previewTarget.kind === "saved"
        ? buildGlobalSectionPreviewUrl(
            previewUrl,
            livePageResolveType,
            previewTarget.blockKey,
          )
        : buildInlineSectionPreviewUrl(
            previewUrl,
            livePageResolveType,
            previewTarget.resolveType,
            previewTarget.data,
            theme,
          );
    return withDeviceHint(base, device);
  };

  const tryApplyJson = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("JSON must be an object.");
        return;
      }
      setJsonError(null);
      onApplyJson(parsed as Record<string, unknown>);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON.");
    }
  };

  const handleJsonChange = (value: string | undefined) => {
    const next = value ?? "";
    setJsonDraft(next);
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    applyTimerRef.current = setTimeout(
      () => tryApplyJson(next),
      JSON_APPLY_DEBOUNCE_MS,
    );
  };

  if (tab === null) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-l pt-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => openTab("preview")}
              aria-label="Show preview"
            >
              <Eye size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Show preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => openTab("json")}
              aria-label="Edit JSON"
            >
              <CurlyBracesIcon size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Edit JSON</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex w-1/2 min-w-[320px] shrink-0 flex-col border-l">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex items-center gap-0.5">
          <TabButton
            active={tab === "preview"}
            onClick={() => setTab("preview")}
            icon={<Eye size={13} />}
            label="Preview"
          />
          <TabButton
            active={tab === "json"}
            onClick={() => openTab("json")}
            icon={<CurlyBracesIcon size={13} />}
            label="JSON"
          />
        </div>
        <div className="flex-1" />
        {tab === "preview" && (
          <>
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
            {onRefreshPreview && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={onRefreshPreview}
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
                  onClick={() => {
                    const url = buildOpenUrl();
                    if (url) window.open(url, "_blank", "noopener");
                  }}
                  aria-label="Open preview in new tab"
                >
                  <LinkExternal01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in new tab</TooltipContent>
            </Tooltip>
          </>
        )}
        {tab === "json" && jsonError && (
          <span className="truncate text-xs text-destructive" title={jsonError}>
            Invalid JSON
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setTab(null)}
              aria-label="Collapse panel"
            >
              <XClose size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Collapse</TooltipContent>
        </Tooltip>
      </div>

      {tab === "preview" ? (
        <PreviewSurface
          previewUrl={previewUrl}
          livePageResolveType={livePageResolveType}
          target={previewTarget}
          theme={theme}
          reloadKey={reloadKey}
          device={device}
        />
      ) : (
        <div className="min-h-0 flex-1">
          <MonacoCodeEditor
            code={jsonDraft}
            language="json"
            height="100%"
            onChange={handleJsonChange}
            onSave={(value) => tryApplyJson(value)}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
