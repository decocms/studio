/**
 * Threads Sidebar Component
 *
 * A right-side sliding panel that displays chat thread history.
 */

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { isDecopilot } from "@decocms/mesh-sdk";
import { Check, Edit01, MessageChatSquare, Users03 } from "@untitledui/icons";
import { useState } from "react";
import { useChatStable } from "./context";
import type { Thread } from "./types.ts";

/**
 * ThreadsViewContent Component
 *
 * Core content component for displaying threads (header, search, list).
 * Does not include any wrapper - meant to be used within different containers.
 */
interface ThreadsViewContentProps {
  threads: Thread[];
  activeThreadId: string;
  onThreadSelect: (threadId: string) => void;
  onClose?: () => void;
  showHeader?: boolean;
  showBackButton?: boolean;
}

function ThreadsViewContent({
  threads,
  activeThreadId,
  onThreadSelect,
  onClose,
  showHeader = true,
  showBackButton = false,
}: ThreadsViewContentProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const { renameThread, virtualMcps } = useChatStable();

  const filteredThreads = !searchQuery.trim()
    ? threads
    : threads.filter((thread) =>
        (thread.title || "New chat")
          .toLowerCase()
          .includes(searchQuery.toLowerCase()),
      );

  const handleThreadSelect = (threadId: string) => {
    onThreadSelect(threadId);
    if (onClose) {
      onClose();
    }
  };

  const startEditing = (thread: Thread, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingThreadId(thread.id);
    setEditingTitle(thread.title || "");
  };

  const commitEdit = async (threadId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      await renameThread(threadId, trimmed);
    }
    setEditingThreadId(null);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    threadId: string,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(threadId);
    } else if (e.key === "Escape") {
      setEditingThreadId(null);
    }
  };

  const getThreadAgent = (thread: Thread) => {
    const ref = thread.description;
    if (!ref) return null;
    // Treat stored decopilot IDs and the old stored title "Decopilot" as no-agent
    if (isDecopilot(ref) || ref.toLowerCase() === "decopilot") return null;
    // ID match (new format) then title match (old format where title was stored)
    return (
      virtualMcps.find((v) => v.id === ref) ??
      virtualMcps.find((v) => v.title === ref) ??
      null
    );
  };

  return (
    <>
      {/* Header */}
      {showHeader && (
        <div className="h-12 px-4 flex items-center justify-between border-b shrink-0">
          <span className="text-sm font-medium">Chat History</span>
          {showBackButton && (
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Back to chat
            </button>
          )}
        </div>
      )}

      <CollectionSearch
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search conversations..."
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setSearchQuery("");
            (e.target as HTMLInputElement).blur();
          }
        }}
      />

      {/* Threads list */}
      <div className="flex-1 overflow-y-auto">
        {filteredThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
            <div className="size-12 rounded-full bg-muted/50 flex items-center justify-center">
              <MessageChatSquare size={24} className="text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {searchQuery ? "No results found" : "No conversations yet"}
              </p>
              <p className="text-xs text-muted-foreground">
                {searchQuery
                  ? "Try a different search term"
                  : "Start a new chat to see your history here"}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col py-2">
            {filteredThreads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              const isEditing = editingThreadId === thread.id;
              const agent = getThreadAgent(thread);
              return (
                <div
                  key={thread.id}
                  className={cn(
                    "group flex items-center gap-2 px-4 py-3 transition-colors hover:bg-accent/50 cursor-pointer",
                    isActive && "bg-accent/50",
                  )}
                  onClick={() => !isEditing && handleThreadSelect(thread.id)}
                >
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onBlur={() => commitEdit(thread.id)}
                          onKeyDown={(e) => handleKeyDown(e, thread.id)}
                          className="flex-1 text-sm bg-transparent border-b border-foreground/30 focus:border-foreground outline-none pb-0.5 min-w-0"
                        />
                        <button
                          type="button"
                          onClick={() => commitEdit(thread.id)}
                          className="p-1 hover:bg-accent rounded shrink-0"
                        >
                          <Check
                            size={12}
                            className="text-muted-foreground hover:text-foreground"
                          />
                        </button>
                      </div>
                    ) : (
                      <p
                        className={cn(
                          "text-sm truncate",
                          isActive
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {thread.title || "New chat"}
                      </p>
                    )}
                    {!isEditing && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(thread.updated_at).toLocaleDateString(
                          undefined,
                          {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </p>
                    )}
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      {agent && (
                        <div title={agent.title}>
                          <IntegrationIcon
                            icon={agent.icon}
                            name={agent.title}
                            size="xs"
                            fallbackIcon={<Users03 size={12} />}
                          />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => startEditing(thread, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-accent rounded transition-opacity"
                        title="Rename thread"
                      >
                        <Edit01
                          size={13}
                          className="text-muted-foreground hover:text-foreground"
                        />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

interface ThreadsSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: Thread[];
  activeThreadId: string;
  onThreadSelect: (threadId: string) => void;
}

export function ThreadsSidebar({
  open,
  onOpenChange,
  threads,
  activeThreadId,
  onThreadSelect,
}: ThreadsSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:w-[540px] p-0 flex flex-col"
      >
        <SheetHeader className="h-12 px-4 flex flex-row items-center justify-between border-b shrink-0">
          <SheetTitle className="text-sm font-medium">Chat History</SheetTitle>
        </SheetHeader>

        <ThreadsViewContent
          threads={threads}
          activeThreadId={activeThreadId}
          onThreadSelect={onThreadSelect}
          showHeader={false}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * ThreadsView Component
 *
 * A full-view of threads for the lateral chat panel.
 * Uses CSS visibility toggle instead of z-index overlay.
 */
interface ThreadsViewProps {
  threads: Thread[];
  activeThreadId: string;
  onThreadSelect: (threadId: string) => void;
  onClose: () => void;
}

export function ThreadsView({
  threads,
  activeThreadId,
  onThreadSelect,
  onClose,
}: ThreadsViewProps) {
  return (
    <div className="flex flex-col h-full w-full bg-background">
      <ThreadsViewContent
        threads={threads}
        activeThreadId={activeThreadId}
        onThreadSelect={onThreadSelect}
        onClose={onClose}
        showBackButton
      />
    </div>
  );
}
