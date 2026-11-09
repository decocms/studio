import { useState } from "react";
import { RefreshCw01 } from "@untitledui/icons";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useT } from "@/i18n/use-t";
import { PreviewFrame } from "./preview-frame";
import { PreviewCanvas, PreviewNavigation } from "./preview-surface";
import type { PreviewDeviceSize } from "./device-hint";

/** Supplies a deployed URL to the shared preview without sandbox lifecycle hooks. */
export function UrlPreview({ url }: { url: string }) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  const [device, setDevice] = useState<PreviewDeviceSize>("desktop");
  return (
    <section
      className="surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      aria-label={t("structuredMarkdown.preview")}
    >
      <div className="shrink-0 border-b px-2 py-2 [&>div]:w-full">
        <PreviewNavigation
          device={device}
          onDeviceChange={setDevice}
          onOpen={() => window.open(url, "_blank", "noopener,noreferrer")}
          urlControls={
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground hover:text-foreground"
            >
              {url.replace(/^https?:\/\//, "")}
            </a>
          }
          actions={
            <ToolbarIconButton
              aria-label={t("structuredMarkdown.reload")}
              onClick={() => setRevision(revision + 1)}
            >
              <RefreshCw01 size={16} />
            </ToolbarIconButton>
          }
        />
      </div>
      <div className="min-h-0 flex-1">
        <PreviewCanvas
          device={device}
          frame={
            <PreviewFrame
              key={`${url}:${revision}`}
              src={url}
              title={t("structuredMarkdown.preview")}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              referrerPolicy="strict-origin-when-cross-origin"
              className="block h-full w-full border-0 bg-background"
            />
          }
        />
      </div>
    </section>
  );
}
