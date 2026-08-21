import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ChevronRight, DotsHorizontal, File06 } from "@untitledui/icons";
import { useState } from "react";
import { DiffEditor } from "@/components/monaco/editor";
import { useT } from "@/i18n/use-t.ts";
import { getLanguageFromPath } from "../../sandbox/preview/file-explorer/utils.ts";
import type { GitDiffResult } from "./sandbox-git-api.ts";

function editorTheme(): "vs" | "vs-dark" {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

const GHOST_DIFF_ROWS = [
  { width: "w-3/4", tone: "ctx" },
  { width: "w-1/2", tone: "del" },
  { width: "w-3/5", tone: "add" },
  { width: "w-2/5", tone: "ctx" },
  { width: "w-4/5", tone: "add" },
  { width: "w-1/2", tone: "ctx" },
] as const;

/** Skeleton shown while the Monaco bundle loads — shaped like a diff so the
 *  editor fades into rows that were already there instead of a blank flash. */
function DiffLoadingGhost({ height }: { height: string }) {
  const t = useT();
  return (
    <div
      style={{ height }}
      className="flex w-full flex-col gap-1.5 overflow-hidden px-3 py-2"
    >
      {GHOST_DIFF_ROWS.map((row, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-2 rounded px-1 py-0.5",
            row.tone === "del" && "bg-destructive/5",
            row.tone === "add" && "bg-success/5",
          )}
        >
          <div
            className={cn(
              "h-2 w-4 shrink-0 animate-pulse rounded-sm bg-muted",
              row.tone === "del" && "bg-destructive/20",
              row.tone === "add" && "bg-success/25",
            )}
          />
          <div
            className={cn(
              "h-2 animate-pulse rounded-sm bg-muted",
              row.width,
              row.tone === "del" && "bg-destructive/20",
              row.tone === "add" && "bg-success/25",
            )}
          />
        </div>
      ))}
      <div className="flex items-center justify-center pt-1 text-[11px] text-muted-foreground">
        {t("thread.publishDialog.openingComparison")}
      </div>
    </div>
  );
}

/** Shared by both editors so the embedded one can't drift from the dialog's. */
const DIFF_EDITOR_OPTIONS = {
  readOnly: true,
  renderSideBySide: false,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
} as const;

/**
 * The card's editor drops the chrome that competes with a 220px pane, but
 * keeps line numbers: they are how a reader says which line they mean, and a
 * JSON block is long enough that "the second `title`" is not an answer. The
 * gutter is capped at three digits to stay narrow.
 */
const EMBEDDED_DIFF_EDITOR_OPTIONS = {
  ...DIFF_EDITOR_OPTIONS,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 4,
  folding: false,
  glyphMargin: false,
  renderOverviewRuler: false,
} as const;

export interface GitDiffListProps {
  diff: GitDiffResult | null | undefined;
  emptyMessage?: string;
  rowClassName?: string;
  onDiscardFile?: (filepath: string) => void | Promise<void>;
  /**
   * Render only the always-open editors, no per-file header rows — for hosts
   * that already name the file (the publish popover's change cards).
   */
  hideFileRows?: boolean;
  /** Monaco diff height; the default suits the full-size dialog. */
  editorHeight?: string;
}

export function GitDiffList({
  diff,
  emptyMessage = "No file changes in the working tree",
  rowClassName = "px-6",
  onDiscardFile,
  hideFileRows = false,
  editorHeight = "380px",
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
          ? "bg-success"
          : isDeleted
            ? "bg-destructive"
            : "bg-warning";

        if (hideFileRows) {
          return (
            <div key={filepath}>
              <DiffEditor
                original={from ?? ""}
                modified={to ?? ""}
                language={language}
                theme={theme}
                height={editorHeight}
                loading={<DiffLoadingGhost height={editorHeight} />}
                options={EMBEDDED_DIFF_EDITOR_OPTIONS}
              />
            </div>
          );
        }

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
                  height={editorHeight}
                  loading={<DiffLoadingGhost height={editorHeight} />}
                  options={DIFF_EDITOR_OPTIONS}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
