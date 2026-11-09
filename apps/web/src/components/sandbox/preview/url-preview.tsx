import { useState } from "react";
import {
  Globe01,
  Monitor04,
  Phone02,
  RefreshCw01,
  LinkExternal01,
} from "@untitledui/icons";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { useElementSize } from "@/hooks/use-element-size";
import { previewViewportLayout } from "./preview-viewport";
import { useT } from "@/i18n/use-t";
import { PreviewFrame } from "./preview-frame";

/** URL-only preview for an existing deployment, without sandbox lifecycle hooks. */
export function UrlPreview({ url }: { url: string }) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  const [mobile, setMobile] = useState(false);
  const [canvasSize, canvasRef] = useElementSize();
  const { style } = previewViewportLayout(
    mobile ? "mobile" : "desktop",
    canvasSize,
  );
  return (
    <section
      className="surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      aria-label={t("structuredMarkdown.preview")}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <Globe01 className="mx-1 size-4 shrink-0 text-muted-foreground" />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground hover:text-foreground"
        >
          {url.replace(/^https?:\/\//, "")}
        </a>
        <IconButton
          label={t("structuredMarkdown.desktop")}
          aria-pressed={!mobile}
          variant={!mobile ? "secondary" : "ghost"}
          onClick={() => setMobile(false)}
        >
          <Monitor04 />
        </IconButton>
        <IconButton
          label={t("structuredMarkdown.mobile")}
          aria-pressed={mobile}
          variant={mobile ? "secondary" : "ghost"}
          onClick={() => setMobile(true)}
        >
          <Phone02 />
        </IconButton>
        <IconButton
          label={t("structuredMarkdown.reload")}
          onClick={() => setRevision(revision + 1)}
        >
          <RefreshCw01 />
        </IconButton>
        <IconButton asChild label={t("structuredMarkdown.openExternal")}>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <LinkExternal01 />
          </a>
        </IconButton>
      </div>
      <div
        ref={canvasRef}
        className="flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/30"
      >
        <div className="shrink-0" style={style}>
          <PreviewFrame
            key={`${url}:${revision}`}
            src={url}
            title={t("structuredMarkdown.preview")}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            referrerPolicy="strict-origin-when-cross-origin"
            className="block h-full w-full border-0 bg-background"
          />
        </div>
      </div>
    </section>
  );
}
