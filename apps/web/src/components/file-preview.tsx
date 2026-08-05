/**
 * FilePreview — inline viewer for a stored file, shared by the chat
 * file tab (thread outputs) and the Library page (org-fs files). Takes a
 * resolved {key, filename, size, downloadUrl}; the caller owns chrome
 * (toolbar, close) and data fetching.
 *
 * Rendering strategy by extension:
 *   - image → <img> (same-origin URL, bytes proxied by studio; no CORS needed)
 *   - pdf   → <iframe> (browser-native viewer; NOT sandboxed — a sandbox
 *             without allow-scripts would disable Chrome's PDF plugin)
 *   - html  → <iframe sandbox="allow-scripts"> (untrusted; opaque-origin sandbox)
 *   - md    → fetched and rendered through the chat markdown renderer
 *   - text  → fetched and rendered in a read-only Monaco code viewer
 *   - other (xlsx/pptx/zip/…) → download card fallback
 *
 * Text-ish fetches go through `fetch(credentials: "include")`; if that
 * fails, the component degrades to the download card rather than erroring.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Download01 } from "@untitledui/icons";
import { useFileText } from "@/hooks/use-org-fs";
import { ReadOnlyCodeViewer } from "@/components/read-only-code-viewer";
import { FileTypeIcon } from "@/components/file-type-icon";
import { MemoizedMarkdown } from "@/components/chat/markdown.tsx";

/** The minimum a caller must resolve to preview a file. */
export interface PreviewableFile {
  /** Stable identity (S3 key, org-fs path, …) — keys the markdown renderer. */
  key: string;
  filename: string;
  size: number;
  downloadUrl: string;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

export function FilePreviewShimmer() {
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

function DownloadCard({
  file,
  note,
}: {
  file: PreviewableFile;
  note?: string;
}) {
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
  file: PreviewableFile;
  markdown: boolean;
}) {
  const { data, isPending, isError } = useFileText(file.downloadUrl);

  if (isPending) return <FilePreviewShimmer />;
  if (isError || !data) {
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
  return <ReadOnlyCodeViewer value={data} filename={file.filename} />;
}

export function FilePreview({ file }: { file: PreviewableFile }) {
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
          sandbox="allow-scripts allow-downloads"
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
