/**
 * File Browser Component
 *
 * Main file browser for S3-compatible storage with table and grid views.
 * Features: breadcrumb navigation, folder navigation, file actions, upload.
 * Path and view mode are persisted in the URL for refresh persistence.
 */

import { useState, useRef, lazy, Suspense } from "react";
import { OBJECT_STORAGE_BINDING } from "@decocms/bindings";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { useObjects } from "../hooks/use-objects";
import {
  getFileName,
  formatFileSize,
  formatDate,
  parsePathSegments,
} from "../lib/utils";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Folder,
  File02,
  ChevronRight,
  Home02,
  Upload01,
  Download01,
  Trash01,
  Loading01,
  AlertCircle,
  FolderPlus,
  List,
  Grid01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { objectStorageRouter } from "../lib/router";

const GridView = lazy(() => import("./grid-view"));

interface FileRowProps {
  item: {
    key: string;
    size: number;
    lastModified: string;
    isFolder: boolean;
  };
  selected: boolean;
  showFullPath?: boolean;
  onSelect: (selected: boolean) => void;
  onNavigate: (path: string) => void;
  onViewFile: (key: string) => void;
  onDownload: (key: string) => void;
  onDelete: (key: string) => void;
}

function FileRow({
  item,
  selected,
  showFullPath = false,
  onSelect,
  onNavigate,
  onViewFile,
  onDownload,
  onDelete,
}: FileRowProps) {
  const name = showFullPath ? item.key : getFileName(item.key);

  return (
    <div className="group flex items-center gap-3 px-4 py-2 hover:bg-muted/50 border-b border-border last:border-b-0">
      <Checkbox
        checked={selected}
        onCheckedChange={onSelect}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=checked]:opacity-100"
      />

      <button
        type="button"
        onClick={() =>
          item.isFolder ? onNavigate(item.key) : onViewFile(item.key)
        }
        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer hover:text-primary"
      >
        {item.isFolder ? (
          <Folder size={18} className="text-amber-500 shrink-0" />
        ) : (
          <File02 size={18} className="text-muted-foreground shrink-0" />
        )}
        <span className="truncate">{name}</span>
      </button>

      <span className="text-sm text-muted-foreground w-20 text-right shrink-0">
        {item.isFolder ? "-" : formatFileSize(item.size)}
      </span>

      <span className="text-sm text-muted-foreground w-28 text-right shrink-0">
        {item.isFolder ? "-" : formatDate(item.lastModified)}
      </span>

      <div className="flex items-center gap-1 w-16 justify-end shrink-0 opacity-0 group-hover:opacity-100">
        {!item.isFolder && (
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            onClick={() => onDownload(item.key)}
          >
            <Download01 size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0 text-destructive hover:text-destructive"
          onClick={() => onDelete(item.key)}
        >
          <Trash01 size={14} />
        </Button>
      </div>
    </div>
  );
}

interface BreadcrumbProps {
  prefix: string;
  onNavigate: (path: string) => void;
}

function Breadcrumb({ prefix, onNavigate }: BreadcrumbProps) {
  const segments = parsePathSegments(prefix);

  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate("")}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <Home02 size={16} />
      </button>

      {segments.map((segment, i) => (
        <div key={segment.path} className="flex items-center gap-1">
          <ChevronRight size={14} className="text-muted-foreground" />
          <button
            type="button"
            onClick={() => onNavigate(segment.path)}
            className={cn(
              "hover:text-primary",
              i === segments.length - 1
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {segment.name}
          </button>
        </div>
      ))}
    </div>
  );
}

export default function FileBrowser() {
  // Path and view mode are persisted in URL for refresh persistence
  const {
    path: prefix = "",
    flat = false,
    view = "table",
  } = objectStorageRouter.useSearch({
    from: "/",
  });
  const navigate = objectStorageRouter.useNavigate();

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const viewFile = (key: string) => {
    navigate({ to: "/viewer", search: { key } });
  };

  const setPrefix = (newPath: string) => {
    setSelectedKeys(new Set()); // Clear selection when navigating folders
    navigate({ to: "/", search: { path: newPath || undefined, flat, view } });
  };

  const setFlat = (newFlat: boolean) => {
    setSelectedKeys(new Set()); // Clear selection when switching view mode
    // Reset to root when switching to flat mode, preserve path in directory mode
    navigate({
      to: "/",
      search: {
        path: newFlat ? undefined : prefix || undefined,
        flat: newFlat,
        view,
      },
    });
  };

  const setView = (newView: "table" | "grid") => {
    setSelectedKeys(new Set()); // Clear selection when switching view
    navigate({
      to: "/",
      search: {
        path: prefix || undefined,
        flat,
        view: newView,
      },
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { connectionId, toolCaller } =
    usePluginContext<typeof OBJECT_STORAGE_BINDING>();

  const { objects, isLoading, isFetchingMore, hasMore, loadMore, error } =
    useObjects({ prefix, flat });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const key = prefix + file.name;

      // Get presigned URL
      const { url } = await toolCaller("PUT_PRESIGNED_URL", {
        key,
        contentType: file.type || "application/octet-stream",
      });

      // Upload file
      const response = await fetch(url, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      return key;
    },
    onSuccess: (key) => {
      toast.success(`Uploaded ${getFileName(key)}`);
      queryClient.invalidateQueries({
        queryKey: KEYS.objects(connectionId, prefix),
      });
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (keys: string[]) => {
      if (keys.length === 1 && keys[0]) {
        return toolCaller("DELETE_OBJECT", { key: keys[0] });
      }
      return toolCaller("DELETE_OBJECTS", { keys });
    },
    onSuccess: () => {
      toast.success("Deleted successfully");
      setSelectedKeys(new Set());
      queryClient.invalidateQueries({
        queryKey: KEYS.objects(connectionId, prefix),
      });
    },
    onError: (error) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  // Download handler - fetches file and triggers browser download
  const handleDownload = async (key: string) => {
    try {
      const { url } = await toolCaller("GET_PRESIGNED_URL", { key });

      // Fetch the file content
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      // Create blob and trigger download
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = getFileName(key);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up the object URL
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      toast.error(
        `Download failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  // File input change handler
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      uploadMutation.mutate(file);
    }

    // Reset input
    e.target.value = "";
  };

  // Selection handlers
  const handleSelect = (key: string, selected: boolean) => {
    const newSelected = new Set(selectedKeys);
    if (selected) {
      newSelected.add(key);
    } else {
      newSelected.delete(key);
    }
    setSelectedKeys(newSelected);
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      setSelectedKeys(new Set(objects.map((o) => o.key)));
    } else {
      setSelectedKeys(new Set());
    }
  };

  const handleDeleteSelected = () => {
    if (selectedKeys.size === 0) return;
    deleteMutation.mutate(Array.from(selectedKeys));
  };

  // Scroll handler for infinite loading
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || isFetchingMore) return;

    const target = e.currentTarget;
    const scrollBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight;

    if (scrollBottom < 200) {
      loadMore();
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle size={48} className="text-destructive mb-4" />
        <h3 className="text-lg font-medium mb-2">Error loading files</h3>
        <p className="text-muted-foreground text-center">{error.message}</p>
      </div>
    );
  }

  // Grid view handles its own rendering
  if (view === "grid") {
    return (
      <div className="flex flex-col h-full">
        {/* Header for grid view */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
          {/* Left side: Breadcrumb or flat title */}
          {flat ? (
            <span className="text-sm text-muted-foreground">
              All files (flat)
            </span>
          ) : (
            <Breadcrumb prefix={prefix} onNavigate={setPrefix} />
          )}

          {/* Right side: Options and view toggle */}
          <div className="flex items-center gap-4">
            {/* Directory mode toggle */}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={!flat}
                onCheckedChange={(checked) => setFlat(!checked)}
              />
              <span className="text-muted-foreground">Show as directories</span>
            </label>

            {/* View toggle buttons */}
            <div className="flex items-center gap-1">
              <Button
                variant={view === "grid" ? "secondary" : "ghost"}
                size="sm"
                className="size-8 p-0"
                onClick={() => setView("grid")}
              >
                <Grid01 size={16} />
              </Button>
              <Button
                variant={view === "table" ? "secondary" : "ghost"}
                size="sm"
                className="size-8 p-0"
                onClick={() => setView("table")}
              >
                <List size={16} />
              </Button>
            </div>

            {/* Upload button */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loading01 size={14} className="mr-1 animate-spin" />
              ) : (
                <Upload01 size={14} className="mr-1" />
              )}
              Upload
            </Button>
          </div>
        </div>

        {/* Grid content */}
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loading01
                size={32}
                className="animate-spin text-muted-foreground"
              />
            </div>
          }
        >
          <GridView prefix={prefix} flat={flat} onNavigate={setPrefix} />
        </Suspense>
      </div>
    );
  }

  // Table view
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
        {/* Left side: Breadcrumb (directory mode) or title (flat mode) */}
        {flat ? (
          <span className="text-sm text-muted-foreground">
            All files (flat)
          </span>
        ) : (
          <Breadcrumb prefix={prefix} onNavigate={setPrefix} />
        )}

        <div className="flex items-center gap-4">
          {/* Directory mode toggle (table view only) */}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={!flat}
              onCheckedChange={(checked) => setFlat(!checked)}
            />
            <span className="text-muted-foreground">Show as directories</span>
          </label>

          {/* View toggle buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="sm"
              className="size-8 p-0"
              onClick={() => setView("grid")}
            >
              <Grid01 size={16} />
            </Button>
            <Button
              variant={view === "table" ? "secondary" : "ghost"}
              size="sm"
              className="size-8 p-0"
              onClick={() => setView("table")}
            >
              <List size={16} />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {selectedKeys.size > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={handleDeleteSelected}
                disabled={deleteMutation.isPending}
              >
                <Trash01 size={14} className="mr-1" />
                Delete ({selectedKeys.size})
              </Button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loading01 size={14} className="mr-1 animate-spin" />
              ) : (
                <Upload01 size={14} className="mr-1" />
              )}
              Upload
            </Button>
          </div>
        </div>
      </div>

      {/* Table Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/30 text-sm font-medium text-muted-foreground">
        <Checkbox
          checked={
            selectedKeys.size > 0 && selectedKeys.size === objects.length
          }
          onCheckedChange={handleSelectAll}
        />
        <span className="flex-1">Name</span>
        <span className="w-20 text-right">Size</span>
        <span className="w-28 text-right">Modified</span>
        <span className="w-16" />
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground mb-4"
            />
            <p className="text-sm text-muted-foreground">Loading files...</p>
          </div>
        ) : objects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderPlus size={48} className="text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">This folder is empty</h3>
            <p className="text-muted-foreground mb-4">
              Upload files to get started
            </p>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload01 size={14} className="mr-1" />
              Upload files
            </Button>
          </div>
        ) : (
          <>
            {objects.map((item) => (
              <FileRow
                key={item.key}
                item={item}
                selected={selectedKeys.has(item.key)}
                showFullPath={flat}
                onSelect={(selected) => handleSelect(item.key, selected)}
                onNavigate={setPrefix}
                onViewFile={viewFile}
                onDownload={handleDownload}
                onDelete={(key) => deleteMutation.mutate([key])}
              />
            ))}

            {isFetchingMore && (
              <div className="flex justify-center py-4">
                <Loading01
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
