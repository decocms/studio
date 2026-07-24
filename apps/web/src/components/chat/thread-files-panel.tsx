/**
 * ThreadFilesPanel — "Files in this task" accordion listing every file the
 * thread has produced (same `threadOutputs` query as the per-turn rows;
 * unlike those, this catches files the per-turn attribution can't see,
 * e.g. bash writing into org/output).
 *
 * Two placements, switched by container query (needs `@container` on the
 * chat main wrapper in side-panel-chat.tsx):
 *   - Wide chat (≥1280px): floating card in the right gutter beside the
 *     centered max-w-2xl message column (672px + ~304px gutter each
 *     side) — the Figma layout. Expanded by default.
 *   - Narrow chat: flat in-flow topbar above the messages (real layout
 *     row closed by a border-b, so it can never overlap a message),
 *     collapsed by default to a slim bar; expanding pushes content like
 *     a normal accordion.
 */

import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown } from "@untitledui/icons";
import { useOptionalChatTask } from "./context.tsx";
import { OutputFileRow } from "./output-file-row.tsx";
import {
  useThreadHasFileWork,
  useThreadOutputs,
  type ThreadOutput,
} from "./use-thread-outputs.ts";

function FilesAccordion({
  outputs,
  collapsed,
  onToggle,
  variant,
}: {
  outputs: ThreadOutput[];
  collapsed: boolean;
  onToggle: () => void;
  variant: "card" | "bar";
}) {
  return (
    <div
      className={cn(
        variant === "card"
          ? "rounded-xl border border-border bg-muted/95 shadow-sm backdrop-blur-sm"
          : "border-b border-border bg-background",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-foreground">
          Files in this task
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {!collapsed && (
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
          {outputs.map((file) => (
            <OutputFileRow key={file.key} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreadFilesPanel() {
  const taskId = useOptionalChatTask()?.taskId ?? null;
  const hasFileWork = useThreadHasFileWork();
  const { data: outputs } = useThreadOutputs(taskId, { enabled: hasFileWork });
  // Independent defaults per placement (only one is visible at a time):
  // the gutter has room to spare, the topbar starts as a slim bar.
  const [gutterCollapsed, setGutterCollapsed] = useState(false);
  const [barCollapsed, setBarCollapsed] = useState(true);

  if (!taskId || !outputs || outputs.length === 0) return null;

  return (
    <>
      {/* Wide: floating in the right gutter (never reaches the column) */}
      <div className="absolute top-2 right-2 z-10 hidden w-72 @[1280px]:block">
        <FilesAccordion
          variant="card"
          outputs={outputs}
          collapsed={gutterCollapsed}
          onToggle={() => setGutterCollapsed((c) => !c)}
        />
      </div>
      {/* Narrow: flat topbar above the messages, closed by a border-b */}
      <div className="shrink-0 @[1280px]:hidden">
        <FilesAccordion
          variant="bar"
          outputs={outputs}
          collapsed={barCollapsed}
          onToggle={() => setBarCollapsed((c) => !c)}
        />
      </div>
    </>
  );
}
