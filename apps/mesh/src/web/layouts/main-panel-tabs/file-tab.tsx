/**
 * FileTab — main-panel preview of a file the thread produced
 * (`?main=file:<encoded key>`).
 *
 * The tab id only carries the output `key`; the file's URL/name/size are
 * resolved from the same `threadOutputs` query the chips and the
 * "Files in this task" panel use, so the server stays the single source
 * of truth for download-URL construction and the three surfaces share one
 * cache entry.
 *
 * Rendering strategy by extension:
 *   - image → <img> (same-origin URL or 302→presigned; no CORS needed)
 *   - pdf   → <iframe> (browser-native viewer; NOT sandboxed — a sandbox
 *             without allow-scripts would disable Chrome's PDF plugin)
 *   - html  → <iframe sandbox="allow-scripts"> (untrusted, mirrors WebPageTab)
 *   - md    → fetched and rendered through the chat markdown renderer
 *   - text  → fetched and rendered in a <pre>
 *   - other (xlsx/pptx/zip/…) → download card fallback
 *
 * Text-ish fetches go through `fetch(credentials: "include")`; if that
 * fails (e.g. a cross-origin presigned redirect without CORS headers),
 * the component degrades to the download card rather than erroring.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Download01, LinkExternal01, XClose } from "@untitledui/icons";
import { KEYS } from "@/web/lib/query-keys";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import { MemoizedMarkdown } from "@/web/components/chat/markdown.tsx";
import {
  formatSize,
  useThreadOutputs,
  type ThreadOutput,
} from "@/web/components/chat/use-thread-outputs.ts";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
]);
const TEXT_EXTS = new Set([
  "txt",
  "json",
  "csv",
  "tsv",
  "log",
  "yaml",
  "yml",
  "xml",
  "toml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "sh",
  "sql",
]);
// Beyond this we don't buffer text into the DOM — download card instead.
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

type PreviewKind = "image" | "pdf" | "html" | "markdown" | "text" | "download";

function previewKind(filename: string, size: number): PreviewKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") {
    return size <= MAX_TEXT_PREVIEW_BYTES ? "markdown" : "download";
  }
  if (TEXT_EXTS.has(ext)) {
    return size <= MAX_TEXT_PREVIEW_BYTES ? "text" : "download";
  }
  return "download";
}

function FileShimmer() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex w-3/4 max-w-md flex-col gap-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

function DownloadCard({ file, note }: { file: ThreadOutput; note?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 px-10 py-8">
        <FileTypeIcon filename={file.filename} className="h-12 w-10" />
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {file.filename}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatSize(file.size)}
            {note ? ` · ${note}` : ""}
          </span>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={file.downloadUrl} download={file.filename}>
            <Download01 size={14} />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

function TextPreview({
  file,
  markdown,
}: {
  file: ThreadOutput;
  markdown: boolean;
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: KEYS.threadOutputText(file.downloadUrl),
    queryFn: async () => {
      const res = await fetch(file.downloadUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      return res.text();
    },
    staleTime: 60_000,
    retry: false,
  });

  if (isPending) return <FileShimmer />;
  if (isError || data === undefined) {
    return <DownloadCard file={file} note="preview unavailable" />;
  }

  if (markdown) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-6">
          <MemoizedMarkdown id={`file-preview-${file.key}`} text={data} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <pre className="px-6 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
        {data}
      </pre>
    </div>
  );
}

function PreviewBody({ file }: { file: ThreadOutput }) {
  const kind = previewKind(file.filename, file.size);

  switch (kind) {
    case "image":
      return (
        <div className="flex h-full w-full items-center justify-center overflow-auto bg-muted/30 p-4">
          <img
            src={file.downloadUrl}
            alt={file.filename}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          src={file.downloadUrl}
          title={file.filename}
          className="block h-full w-full bg-white"
        />
      );
    case "html":
      return (
        <iframe
          src={file.downloadUrl}
          title={file.filename}
          sandbox="allow-scripts"
          className="block h-full w-full bg-white"
        />
      );
    case "markdown":
      return <TextPreview file={file} markdown />;
    case "text":
      return <TextPreview file={file} markdown={false} />;
    default:
      return <DownloadCard file={file} />;
  }
}

function FileToolbar({
  file,
  onClose,
}: {
  file: ThreadOutput;
  onClose: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <FileTypeIcon
          filename={file.filename}
          className="h-4.5 w-3.5 shrink-0"
        />
        <span className="truncate text-xs font-medium text-foreground">
          {file.filename}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatSize(file.size)}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" asChild>
            <a href={file.downloadUrl} download={file.filename}>
              <Download01 size={14} />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Download</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.open(file.downloadUrl, "_blank", "noopener")}
          >
            <LinkExternal01 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in new tab</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <XClose size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function FileTab({
  fileKey,
  taskId,
}: {
  fileKey: string;
  taskId: string;
}) {
  const navigate = useNavigate();
  // Always enabled while the tab is open — on a fresh page load the
  // message-scan gate (useThreadHasFileWork) may not have hydrated yet,
  // and an open file tab is itself proof the thread produced files.
  const { data: outputs, isPending } = useThreadOutputs(taskId);
  const file = outputs?.find((o) => o.key === fileKey) ?? null;

  const handleClose = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "0" }),
      replace: true,
    });

  if (!file) {
    if (isPending) {
      return (
        <div className="h-full w-full bg-background">
          <FileShimmer />
        </div>
      );
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background">
        <FileTypeIcon
          filename={fileKey.split("/").pop() ?? fileKey}
          className="h-7.5 w-6"
        />
        <span className="text-sm text-muted-foreground">
          This file is no longer available.
        </span>
        <Button variant="ghost" size="sm" onClick={handleClose}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <FileToolbar file={file} onClose={handleClose} />
      <div className="relative min-h-0 flex-1">
        <PreviewBody file={file} />
      </div>
    </div>
  );
}
