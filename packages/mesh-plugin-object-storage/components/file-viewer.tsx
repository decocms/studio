/**
 * File Viewer Route Component
 *
 * Dedicated route for viewing a single file's content.
 * Navigated to via /viewer?key=path/to/file.ext
 * Markdown files get a Raw/Preview toggle.
 */

import { useState, lazy, Suspense } from "react";
import { OBJECT_STORAGE_BINDING } from "@decocms/bindings";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ArrowLeft,
  Loading01,
  AlertCircle,
  Download01,
} from "@untitledui/icons";
import { getFileName } from "../lib/utils";
import { KEYS } from "../lib/query-keys";
import { objectStorageRouter } from "../lib/router";

const LazyMarkdown = lazy(() =>
  import("@deco/ui/components/markdown.tsx").then((m) => ({
    default: m.Markdown,
  })),
);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

export default function FileViewer() {
  const { key } = objectStorageRouter.useSearch({ from: "/viewer" });
  const navigate = objectStorageRouter.useNavigate();
  const { connectionId, toolCaller } =
    usePluginContext<typeof OBJECT_STORAGE_BINDING>();

  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
  const fileName = getFileName(key);

  const [viewMode, setViewMode] = useState<"raw" | "preview">(
    isMarkdown ? "preview" : "raw",
  );

  const goBack = () => {
    navigate({ to: "/", search: {} });
  };

  // For images: fetch only the presigned URL
  const {
    data: presignedUrl,
    isLoading: isLoadingUrl,
    error: urlError,
  } = useQuery({
    queryKey: KEYS.imagePreview(connectionId, key),
    queryFn: async () => {
      const result = await toolCaller("GET_PRESIGNED_URL", { key });
      return result.url;
    },
    enabled: isImage,
    staleTime: 5 * 60 * 1000,
  });

  // For non-images: fetch content as text
  const {
    data: fileData,
    isLoading: isLoadingContent,
    error: contentError,
  } = useQuery({
    queryKey: KEYS.fileContent(connectionId, key),
    queryFn: async () => {
      const result = await toolCaller("GET_PRESIGNED_URL", { key });
      const response = await fetch(result.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }
      const text = await response.text();
      return { text, downloadUrl: result.url };
    },
    enabled: !isImage,
    staleTime: 60 * 1000,
  });

  const isLoading = isImage ? isLoadingUrl : isLoadingContent;
  const error = isImage ? urlError : contentError;
  const downloadUrl = isImage ? presignedUrl : fileData?.downloadUrl;
  const textContent = fileData?.text;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0"
          onClick={goBack}
        >
          <ArrowLeft size={16} />
        </Button>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium truncate">{fileName}</span>
          <span className="text-xs text-muted-foreground truncate">{key}</span>
        </div>

        {/* Raw / Preview toggle for markdown files */}
        {isMarkdown && textContent != null && (
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button
              variant={viewMode === "raw" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setViewMode("raw")}
            >
              Raw
            </Button>
            <Button
              variant={viewMode === "preview" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setViewMode("preview")}
            >
              Preview
            </Button>
          </div>
        )}

        {downloadUrl && (
          <Button variant="outline" size="sm" asChild>
            <a
              href={downloadUrl}
              download={fileName}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download01 size={14} className="mr-1" />
              Download
            </a>
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground mb-4"
            />
            <p className="text-sm text-muted-foreground">Loading file...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <AlertCircle size={48} className="text-destructive mb-4" />
            <h3 className="text-lg font-medium mb-2">Error loading file</h3>
            <p className="text-muted-foreground text-center">
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
          </div>
        ) : isImage && presignedUrl ? (
          <div className="flex items-center justify-center p-8">
            <img
              src={presignedUrl}
              alt={fileName}
              className="max-w-full max-h-[80vh] object-contain rounded-lg"
            />
          </div>
        ) : isMarkdown && textContent != null && viewMode === "preview" ? (
          <div className="p-6 max-w-3xl mx-auto">
            <Suspense
              fallback={
                <Loading01
                  size={24}
                  className="animate-spin text-muted-foreground"
                />
              }
            >
              <LazyMarkdown>{textContent}</LazyMarkdown>
            </Suspense>
          </div>
        ) : textContent != null ? (
          <pre className="p-6 text-sm font-mono whitespace-pre-wrap break-words">
            {textContent}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
