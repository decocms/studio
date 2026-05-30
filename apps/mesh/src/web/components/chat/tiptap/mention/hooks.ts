import { KEYS } from "@/web/lib/query-keys";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PluginKey } from "@tiptap/pm/state";
import type { Editor, Range } from "@tiptap/react";
import {
  Suggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

// ============================================================================
// Types
// ============================================================================

export interface BaseItem {
  title?: string;
  name: string;
  description?: string;
  icon?: string | null;
  /** Show an Enter key hint — indicates this item drills into a submenu */
  drillable?: boolean;
}

export type OnSelectProps<T extends BaseItem = BaseItem> = {
  range: Range;
  item: T;
};

export interface UseSuggestionOptions<T extends BaseItem = BaseItem> {
  /** The Tiptap editor instance */
  editor: Editor;
  /** Base query key for React Query caching (will be combined with the search query) */
  queryKey: readonly unknown[];
  /** Async function to fetch items based on query */
  queryFn: (props: { query: string }) => Promise<T[]>;
  /** Callback executed when a suggestion is selected. Can be async - menu will show loading state until resolved.
   *  Return false to keep the menu open (e.g. for drill-in navigation). */
  onSelect: (props: OnSelectProps<T>) => void | false | Promise<void | false>;
}

export interface UseSuggestionReturn<T extends BaseItem = BaseItem> {
  /** Current items to display */
  items: T[];
  /** The item currently being selected (async loading) */
  selectedItem: T | null;
  /** Currently selected index */
  selectedIndex: number | undefined;
  /** Close the menu */
  close: () => void;
  /** Select an item - waits for async onSelect before closing */
  onSelect: (item: T, index: number) => void;
}

// ============================================================================
// Internal Hooks
// ============================================================================

/**
 * Hook that implements keyboard navigation for dropdown menus.
 */
function useMenuNavigation<T>({
  editor,
  query,
  items,
  onSelect,
  onClose,
}: {
  editor: Editor;
  query?: string;
  items: T[];
  onSelect?: (item: T, index: number) => void;
  onClose?: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // Store current values in refs for keyboard handler closure
  const itemsRef = useRef(items);
  const selectedIndexRef = useRef(selectedIndex);
  const onSelectRef = useRef(onSelect);
  const onCloseRef = useRef(onClose);

  const deferredQuery = useDeferredValue(query);

  // Reset selection when query changes
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setSelectedIndex(0);
  }, [deferredQuery]);

  // Reset selection when items shrink and current index is out of bounds
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (selectedIndex >= items.length && items.length > 0) {
      setSelectedIndex(0);
    }
  }, [items.length, selectedIndex]);

  // Keep refs in sync with props/state
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Attach keyboard listener to editor
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (editor?.isDestroyed) return undefined;

    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      // Editor view not mounted yet (or already torn down). Bail; the effect
      // will re-run when the editor reference changes.
      return undefined;
    }
    if (!dom) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const currentItems = itemsRef.current;
      if (!currentItems.length) return false;

      const moveNext = () =>
        setSelectedIndex((current) => (current + 1) % currentItems.length);

      const movePrev = () =>
        setSelectedIndex(
          (current) =>
            (current - 1 + currentItems.length) % currentItems.length,
        );

      switch (event.key) {
        case "ArrowUp": {
          event.preventDefault();
          movePrev();
          return true;
        }

        case "ArrowDown": {
          event.preventDefault();
          moveNext();
          return true;
        }

        case "Tab": {
          event.preventDefault();
          if (event.shiftKey) {
            movePrev();
          } else {
            moveNext();
          }
          return true;
        }

        case "Home": {
          event.preventDefault();
          setSelectedIndex(0);
          return true;
        }

        case "End": {
          event.preventDefault();
          setSelectedIndex(currentItems.length - 1);
          return true;
        }

        case "Enter": {
          if (event.isComposing) return false;
          event.preventDefault();
          const currentSelectedIndex = selectedIndexRef.current;
          if (
            currentSelectedIndex !== -1 &&
            currentItems[currentSelectedIndex]
          ) {
            onSelectRef.current?.(
              currentItems[currentSelectedIndex],
              currentSelectedIndex,
            );
          }
          return true;
        }

        case "Escape": {
          event.preventDefault();
          onCloseRef.current?.();
          return true;
        }

        default:
          return false;
      }
    };

    const handler = (e: Event) => {
      handleKeyDown(e as KeyboardEvent);
    };
    dom.addEventListener("keydown", handler, true);
    return () => {
      dom?.removeEventListener("keydown", handler, true);
    };
  }, [editor]);

  return {
    selectedIndex: items.length ? selectedIndex : undefined,
    setSelectedIndex,
  };
}

// ============================================================================
// Reducer Types and Implementation
// ============================================================================

export interface SuggestionState {
  open: boolean;
  element: HTMLElement | null;
  query: string;
  range: Range | null;
  selectedItem: BaseItem | null;
}

export type SuggestionAction =
  | { type: "SET_SELECTED_ITEM"; payload: BaseItem | null }
  | {
      type: "ON_START";
      payload: {
        element: HTMLElement | null;
        query: string;
        range: Range;
      };
    }
  | {
      type: "ON_UPDATE";
      payload: {
        element: HTMLElement | null;
        query: string;
        range: Range;
      };
    }
  | { type: "ON_EXIT" };

function reducer(
  state: SuggestionState,
  action: SuggestionAction,
): SuggestionState {
  switch (action.type) {
    case "SET_SELECTED_ITEM":
      return { ...state, selectedItem: action.payload };
    case "ON_START":
      return {
        ...state,
        open: true,
        selectedItem: null,
        element: action.payload.element,
        query: action.payload.query,
        range: action.payload.range,
      };
    case "ON_UPDATE":
      return {
        ...state,
        element: action.payload.element,
        query: action.payload.query,
        range: action.payload.range,
      };
    case "ON_EXIT":
      return {
        open: false,
        element: null,
        query: "",
        range: null,
        selectedItem: null,
      };
    default:
      return state;
  }
}

// ============================================================================
// Context
// ============================================================================

interface SuggestionContextValue {
  state: SuggestionState;
  dispatch: React.Dispatch<SuggestionAction>;
}

const SuggestionContext = createContext<SuggestionContextValue | undefined>(
  undefined,
);

/**
 * Hook to consume the SuggestionContext.
 * Must be used within a SuggestionContext.Provider.
 */
export function useSuggestionContext(): SuggestionContextValue {
  const context = useContext(SuggestionContext);
  if (!context) {
    throw new Error(
      "useSuggestionContext must be used within a SuggestionContext.Provider",
    );
  }
  return context;
}

// Export context for use in components
export { SuggestionContext };

// ============================================================================
// Merged Hook
// ============================================================================

/**
 * Merged hook that combines reducer state and plugin registration.
 * Returns state and dispatch for use in context.
 */
export function useMentionState({
  editor,
  char,
  pluginKey,
  allow: customAllow,
  onOpenChange,
}: {
  editor: Editor;
  char: string;
  pluginKey: string | PluginKey;
  allow?: (props: {
    state: unknown;
    range: { from: number; to: number };
  }) => boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // Create the reducer state here - this is the source of truth
  const [state, dispatch] = useReducer(reducer, {
    open: false,
    element: null,
    query: "",
    range: null,
    selectedItem: null,
  });

  // Ref for onOpenChange to avoid stale closures in the plugin
  const onOpenChangeRef = useRef(onOpenChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  onOpenChangeRef.current = onOpenChange;

  // Register the suggestion plugin here at the top level
  // This ensures it's always active even when the menu is closed
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (editor?.isDestroyed) {
      return;
    }

    const key =
      pluginKey instanceof PluginKey ? pluginKey : new PluginKey(pluginKey);

    // Remove existing plugin if present
    const existingPlugin = editor.state.plugins.find(
      (plugin) => plugin.spec.key === key,
    );
    if (existingPlugin) {
      editor.unregisterPlugin(key);
    }

    const suggestion = Suggestion({
      pluginKey: key,
      editor,
      char,

      allow(props) {
        const $from = editor.state.doc.resolve(props.range.from);

        // Check if we're inside an image node
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === "image") {
            return false;
          }
        }

        // Delegate to custom allow if provided
        if (customAllow && !customAllow(props)) {
          return false;
        }

        return true;
      },

      // Command is intentionally empty - we handle selection in the hook's onSelect
      // to support async callbacks with loading states
      command() {},

      render: () => ({
        onStart: (props: SuggestionProps<BaseItem>) => {
          dispatch({
            type: "ON_START",
            payload: {
              element: (props.decorationNode as HTMLElement) ?? null,
              query: props.query,
              range: props.range,
            },
          });
          onOpenChangeRef.current?.(true);
        },

        onUpdate: (props: SuggestionProps<BaseItem>) => {
          dispatch({
            type: "ON_UPDATE",
            payload: {
              element: (props.decorationNode as HTMLElement) ?? null,
              query: props.query,
              range: props.range,
            },
          });
        },

        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            dispatch({ type: "ON_EXIT" });
            return true;
          }
          return false;
        },

        onExit: () => {
          dispatch({ type: "ON_EXIT" });
          onOpenChangeRef.current?.(false);
        },
      }),

      items: () => [], // We handle items ourselves with async loading
    });

    editor.registerPlugin(suggestion);

    return () => {
      if (!editor?.isDestroyed) {
        editor.unregisterPlugin(key);
      }
    };
  }, [editor, pluginKey, char, dispatch, customAllow]);

  return { state, dispatch };
}

// ============================================================================
// Main Hooks
// ============================================================================

/**
 * Hook that provides suggestion functionality for Tiptap editors.
 * Handles keyboard navigation and async item loading.
 * Uses context for state management - must be used within SuggestionContext.Provider.
 */
export function useSuggestion<T extends BaseItem = BaseItem>({
  editor,
  queryKey,
  queryFn: fetchItems,
  onSelect: onItemSelect,
}: UseSuggestionOptions<T>): UseSuggestionReturn<T> {
  // Get state and dispatch from context
  const { state: menuState, dispatch } = useSuggestionContext();

  // Debounced query for search
  const deferredQuery = useDeferredValue(menuState.query);

  // Fetch items using React Query with Suspense
  // Include `open` in queryKey to separate cache for open/closed states
  const { data: items } = useSuspenseQuery({
    queryKey: KEYS.suggestionItems(queryKey, menuState.open, deferredQuery),
    queryFn: () => {
      // Return empty array immediately when menu is closed (avoids fetching)
      if (!menuState.open) {
        return [] as T[];
      }
      return fetchItems({ query: deferredQuery });
    },
  });

  const close = () => {
    dispatch({ type: "ON_EXIT" });
  };

  const onSelect = async (item: T, _index: number) => {
    if (menuState.selectedItem !== null || !menuState.range) {
      // Already processing a selection or missing required state
      return;
    }

    dispatch({ type: "SET_SELECTED_ITEM", payload: item });

    try {
      const { view } = editor;

      // Calculate the range to use
      const nodeAfter = view.state.selection.$to.nodeAfter;
      const overrideSpace = nodeAfter?.text?.startsWith(" ");

      const rangeToUse = menuState.range
        ? { ...menuState.range }
        : { from: 0, to: 0 };
      if (overrideSpace && menuState.range) {
        rangeToUse.to += 1;
      }

      // Call the global onSelect (may be async)
      // Return false to keep the menu open (drill-in navigation)
      const result = await onItemSelect({ range: rangeToUse, item: item as T });
      if (result === false) {
        // Drill-in: reset selected item but keep menu open
        dispatch({ type: "SET_SELECTED_ITEM", payload: null });
      } else {
        close();
      }
    } catch {
      close();
    }
  };

  const { selectedIndex } = useMenuNavigation({
    editor,
    query: deferredQuery,
    items,
    onSelect,
    onClose: close,
  });

  return {
    selectedItem: menuState.selectedItem as T | null,
    items,
    selectedIndex,
    close,
    onSelect,
  };
}
