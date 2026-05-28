import { DiffEditor, loader } from "@monaco-editor/react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronRight, DotsHorizontal, File06 } from "@untitledui/icons";
import { useState } from "react";
import { getLanguageFromPath } from "../../sandbox/preview/file-explorer/utils.ts";
import type { GitDiffResult } from "./sandbox-git-api.ts";

loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
  },
});

function editorTheme(): "vs" | "vs-dark" {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

export interface GitDiffListProps {
  diff: GitDiffResult | null | undefined;
  emptyMessage?: string;
  rowClassName?: string;
  onDiscardFile?: (filepath: string) => void | Promise<void>;
}

export function GitDiffList({
  diff,
  emptyMessage = "No file changes in the working tree",
  rowClassName = "px-6",
  onDiscardFile,
}: GitDiffListProps) {
  const [expandedDiffFile, setExpandedDiffFile] = useState<string | null>(null);
  const [discardConfirmFile, setDiscardConfirmFile] = useState<string | null>(
    null,
  );
  const theme = editorTheme();

  if (!diff || Object.keys(diff.diffs).length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="divide-y">
      {Object.entries(diff.diffs).map(([filepath, { from, to }]) => {
        const isExpanded = expandedDiffFile === filepath;
        const isNew = from === null;
        const isDeleted = to === null;
        const raw = filepath.startsWith("/") ? filepath.slice(1) : filepath;
        const lastSlash = raw.lastIndexOf("/");
        const basename = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
        const directory = lastSlash >= 0 ? raw.slice(0, lastSlash) : null;
        const language = getLanguageFromPath(filepath);
        const dotColor = isNew
          ? "bg-green-500"
          : isDeleted
            ? "bg-red-500"
            : "bg-amber-500";

        return (
          <div key={filepath}>
            <div
              className={cn(
                "flex items-center gap-3 py-3 hover:bg-muted/30",
                rowClassName,
              )}
            >
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-transform hover:text-foreground"
                onClick={() =>
                  setExpandedDiffFile(isExpanded ? null : filepath)
                }
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              </button>
              <div
                className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotColor)}
              />
              <File06 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {basename}
              </span>
              {directory && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {directory}
                </span>
              )}
              {onDiscardFile ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <DotsHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setDiscardConfirmFile(filepath)}
                    >
                      Discard changes
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            {discardConfirmFile === filepath && onDiscardFile ? (
              <div
                className={cn(
                  "flex items-center justify-between gap-3 border-t bg-destructive/5 py-2.5",
                  rowClassName,
                )}
              >
                <span className="text-xs text-destructive">
                  Discard all changes to{" "}
                  <span className="font-medium">{basename}</span>? This cannot
                  be undone.
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setDiscardConfirmFile(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      setDiscardConfirmFile(null);
                      void onDiscardFile(filepath);
                    }}
                  >
                    Discard
                  </Button>
                </div>
              </div>
            ) : null}

            {isExpanded && (
              <div className="border-t">
                <DiffEditor
                  original={from ?? ""}
                  modified={to ?? ""}
                  language={language}
                  theme={theme}
                  height="380px"
                  options={{
                    readOnly: true,
                    renderSideBySide: false,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
