"use client";

import {
  displayToolName,
  getGatewayClientId,
} from "@decocms/mcp-utils/aggregate";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { PluginKey } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { Ref } from "react";
import { PropsWithChildren, Suspense } from "react";
import {
  BaseItem,
  OnSelectProps,
  SuggestionContext,
  useMentionState,
  useSuggestion,
  useSuggestionContext,
} from "./hooks";
import type { MentionAttrs } from "./node.tsx";

export type { MentionAttrs };

// ============================================================================
// Menu Components
// ============================================================================

interface SuggestionSelectProps<T extends BaseItem> {
  /** The Tiptap editor instance */
  editor: Editor;
  /** Trigger character (e.g., "/" for prompts, "@" for resources) */
  char: string;
  /** Unique key for the suggestion plugin */
  pluginKey: string | PluginKey;
  /** Base query key for React Query caching */
  queryKey: readonly unknown[];
  /** Async function to fetch items based on query */
  queryFn: (props: { query: string }) => Promise<T[]>;
  /** Callback executed when a suggestion is selected */
  onSelect: (props: OnSelectProps<T>) => void | Promise<void>;
}

interface MentionItemProps<T extends BaseItem> {
  item: T;
  isSelected: boolean;
  onSelect: () => void;
  isLoading: boolean;
  ref?: Ref<HTMLDivElement>;
}

interface MentionItemListProps<T extends BaseItem> {
  editor: Editor;
  queryKey: readonly unknown[];
  queryFn: (props: { query: string }) => Promise<T[]>;
  onSelect: (props: OnSelectProps<T>) => void | Promise<void>;
}

/**
 * Component that uses Floating UI for the suggestion menu.
 * Positions the menu relative to the Tiptap decoration element.
 */
function MentionAnchor({ children }: PropsWithChildren) {
  const { state, dispatch } = useSuggestionContext();
  const { open, element } = state;

  const close = () => {
    dispatch({ type: "ON_EXIT" });
  };

  const { refs, floatingStyles, context } = useFloating({
    placement: "bottom-start",
    open,
    onOpenChange: (newOpen) => {
      if (!newOpen) {
        close();
      }
    },
    elements: {
      reference: element,
    },
    middleware: [offset(10), flip(), shift()],
    whileElementsMounted: autoUpdate,
  });

  const dismiss = useDismiss(context, {
    outsidePress: (event) => {
      // Allow clicking on the editor
      if (
        event.target instanceof Element &&
        event.target.closest(".ProseMirror")
      ) {
        return false;
      }
      return true;
    },
  });

  const role = useRole(context, { role: "listbox" });

  const { getFloatingProps } = useInteractions([dismiss, role]);

  if (!open) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className="z-50 w-auto min-w-[360px] max-w-[520px] rounded-lg border bg-popover p-0 text-popover-foreground shadow-md outline-hidden overflow-hidden"
      >
        {children}
      </div>
    </FloatingPortal>
  );
}

const MentionItem = <T extends BaseItem>({
  item,
  isSelected,
  onSelect,
  isLoading,
  ref,
}: MentionItemProps<T>) => {
  const clientId = getGatewayClientId((item as Record<string, unknown>)._meta);
  const name = item.title || displayToolName(item.name, clientId);
  const description = item.description || null;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus:bg-accent focus:text-accent-foreground",
        isSelected && "bg-accent text-accent-foreground",
        isLoading && "pointer-events-none opacity-50",
      )}
    >
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium flex items-center truncate capitalize">
            {name}
          </span>
          {isLoading && <Spinner size="xs" />}
        </div>
        {description && (
          <div className="text-xs text-muted-foreground line-clamp-1">
            {description}
          </div>
        )}
      </div>
    </div>
  );
};

const MentionItemList = <T extends BaseItem>({
  editor,
  queryKey,
  queryFn,
  onSelect,
}: MentionItemListProps<T>) => {
  const {
    items,
    selectedIndex,
    onSelect: handleSelect,
    selectedItem,
  } = useSuggestion<T>({
    editor,
    queryKey,
    queryFn,
    onSelect,
  });

  if (!items.length) {
    return (
      <div className="min-w-[360px] max-w-[520px] bg-popover text-popover-foreground rounded-md border shadow-md p-3 text-sm">
        No items found
      </div>
    );
  }

  return (
    <div
      className="min-w-[360px] max-w-[520px] bg-popover text-popover-foreground rounded-md overflow-y-auto"
      style={{
        maxHeight:
          "min(320px, var(--radix-popover-content-available-height, 320px))",
      }}
    >
      <div className="p-1">
        {items.map((item, index) => (
          <MentionItem
            key={item.name}
            item={item}
            isSelected={index === selectedIndex}
            ref={
              index === selectedIndex
                ? (node) => {
                    if (!node) return;
                    node.scrollIntoView({
                      block: "center",
                      behavior: "smooth",
                    });
                  }
                : undefined
            }
            onSelect={() => handleSelect(item, index)}
            isLoading={selectedItem?.name === item.name}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * Skeleton for SuggestionItemList - matches exact structure to avoid CLS
 */
function SuggestionItemListSkeleton() {
  return (
    <div className="p-1">
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 px-2 py-1.5 animate-pulse"
        >
          <div className="h-4 w-24 bg-muted rounded" />
          <div className="h-3 w-32 bg-muted rounded" />
        </div>
      ))}
    </div>
  );
}

/**
 * A unified suggestion selector component for Tiptap editors.
 * Provides context for menu state and wraps the menu UI with Suspense.
 */
export function Suggestion<T extends BaseItem>({
  editor,
  char,
  pluginKey,
  queryKey,
  queryFn,
  onSelect,
}: SuggestionSelectProps<T>) {
  const { state, dispatch } = useMentionState({
    editor,
    char,
    pluginKey,
  });

  // Provide both state and dispatch to children (for useSuggestion)
  return (
    <SuggestionContext.Provider value={{ state, dispatch }}>
      <MentionAnchor>
        <Suspense fallback={<SuggestionItemListSkeleton />}>
          <MentionItemList
            editor={editor}
            queryKey={queryKey}
            queryFn={queryFn}
            onSelect={onSelect}
          />
        </Suspense>
      </MentionAnchor>
    </SuggestionContext.Provider>
  );
}
