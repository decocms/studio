/**
 * The `@` picker: a Tiptap suggestion plugin and the menu it drives.
 *
 * The plugin lives in ProseMirror and the menu in React, so they meet at a
 * tiny store rather than a portal rendered from inside the plugin — one
 * component tree, one place the menu's state can be read.
 *
 * cmdk provides the list, its scroll and the scroll-into-view; the search
 * itself does NOT come from a `CommandInput`. The query is what the user
 * already typed after the `@`, in the editor — a second input under the caret
 * would be a second place to type the same thing.
 */

import { useState, useSyncExternalStore } from "react";
import Suggestion, {
  exitSuggestion,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { createPortal } from "react-dom";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Command,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import {
  useMentionMembers,
  type MentionMember,
} from "@/hooks/use-mention-members";

interface MenuState {
  query: string;
  /** The `@…` text being replaced, for the insert. */
  range: Range | null;
  /** The decoration under the caret, which the menu anchors to. */
  rect: (() => DOMRect | null) | null;
  editor: Editor | null;
}

const CLOSED: MenuState = { query: "", range: null, rect: null, editor: null };

/**
 * The bridge between the plugin and the menu. A store rather than React state
 * because the plugin's callbacks fire outside React's tree and must reach the
 * menu synchronously — `onKeyDown` has to answer "did the menu handle this
 * key?" before ProseMirror moves on.
 */
export class MentionMenuStore {
  private state: MenuState = CLOSED;
  private listeners = new Set<() => void>();
  /** Set by the menu while it's open — arrow keys and Enter belong to it. */
  onKey: ((event: KeyboardEvent) => boolean) | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  set(next: MenuState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  close() {
    this.onKey = null;
    this.set(CLOSED);
  }
}

export const MENTION_SUGGESTION_KEY = new PluginKey("markdownEditorMention");

/** Insert the chip, replacing the typed `@query`. */
function insert(editor: Editor, range: Range, member: MentionMember) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "mention", attrs: { id: member.id, name: member.name } },
      // Without the trailing space the caret sits glued to the chip, and the
      // next character typed reads as part of the name.
      { type: "text", text: " " },
    ])
    .run();
  dismiss(editor);
}

/**
 * Deactivate the suggestion plugin itself, not just the menu.
 *
 * Hiding the React menu leaves the plugin matching, and a matching plugin
 * still claims Enter — so an Escape'd picker would silently swallow the next
 * send. This is the only thing that actually ends the match.
 */
function dismiss(editor: Editor) {
  exitSuggestion(editor.view, MENTION_SUGGESTION_KEY);
}

/**
 * The Tiptap half. `store` is created by the component that owns the editor,
 * so both halves are torn down together.
 */
export function mentionSuggestionExtension(store: MentionMenuStore) {
  return Extension.create({
    name: "mentionSuggestion",
    addProseMirrorPlugins() {
      const options: SuggestionOptions = {
        editor: this.editor,
        char: "@",
        pluginKey: MENTION_SUGGESTION_KEY,
        // An `@` inside a word is an email address, not a mention.
        allowedPrefixes: [" ", "\n"],
        // The list is fetched and filtered in React; the plugin only reports
        // the query.
        items: () => [],
        render: () => ({
          onStart: (props: SuggestionProps) => {
            store.set({
              query: props.query,
              range: props.range,
              rect: props.clientRect ?? null,
              editor: props.editor,
            });
          },
          onUpdate: (props: SuggestionProps) => {
            store.set({
              query: props.query,
              range: props.range,
              rect: props.clientRect ?? null,
              editor: props.editor,
            });
          },
          onKeyDown: ({ event, view }) => {
            if (event.key === "Escape") {
              exitSuggestion(view, MENTION_SUGGESTION_KEY);
              store.close();
              return true;
            }
            return store.onKey?.(event) ?? false;
          },
          onExit: () => store.close(),
        }),
      };
      return [Suggestion(options)];
    },
  });
}

const MENU_WIDTH = 256;
const MENU_MAX_HEIGHT = 280;
const MENU_MIN_HEIGHT = 140;

function matches(member: MentionMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    member.name.toLowerCase().includes(q) ||
    member.email.toLowerCase().includes(q)
  );
}

/**
 * The menu. Renders nothing until the plugin opens it, so the members fetch
 * doesn't run until an `@` is actually typed.
 */
export function MentionMenu({ store }: { store: MentionMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const open = state.range !== null;
  return open ? <OpenMentionMenu store={store} state={state} /> : null;
}

function OpenMentionMenu({
  store,
  state,
}: {
  store: MentionMenuStore;
  state: MenuState;
}) {
  const t = useT();
  const { members, loading } = useMentionMembers(true);
  const [active, setActive] = useState(0);

  const filtered = members.filter((m) => matches(m, state.query));
  // The query narrows as you type, so the previous index can fall off the end.
  const index = Math.min(active, Math.max(filtered.length - 1, 0));
  const selected = filtered[index];

  // Fixed to the caret's own rect, in a body portal so the editor's overflow
  // can't clip it. Full floating-ui placement would buy collision detection
  // against every edge; the only edge a menu under a caret actually hits is
  // the bottom of the viewport, and that's the flip below.
  const caret = state.rect?.() ?? new DOMRect(0, 0, 0, 0);
  const below = window.innerHeight - caret.bottom;
  const flipUp = below < MENU_MAX_HEIGHT && caret.top > below;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(caret.left, window.innerWidth - MENU_WIDTH - 8),
    maxHeight: Math.max(flipUp ? caret.top - 8 : below - 8, MENU_MIN_HEIGHT),
    ...(flipUp
      ? { bottom: window.innerHeight - caret.top + 6 }
      : { top: caret.bottom + 6 }),
  };

  const choose = (member: MentionMember | undefined) => {
    if (!member || !state.editor || !state.range) return;
    insert(state.editor, state.range, member);
    store.close();
  };

  // Registered on every render so it closes over the current list — the plugin
  // asks this synchronously while the keystroke is still cancellable.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- plain field on a store, not a ref read during render
  store.onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      return true;
    }
    if (event.key === "ArrowUp") {
      setActive((i) =>
        filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
      );
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      // Nothing to pick yet: let the key do its normal job rather than
      // swallowing an Enter that was meant to send or break the line.
      if (!selected) return false;
      choose(selected);
      return true;
    }
    return false;
  };

  return createPortal(
    <div
      style={{ ...style, width: MENU_WIDTH }}
      data-testid="mention-menu"
      className="z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-md"
    >
      <Command shouldFilter={false} value={selected?.id ?? ""}>
        <CommandList>
          {/* A cached list is on screen while the refresh runs; the spinner
              is only for the first ever open, with nothing to show. Not
              `CommandEmpty`, which keys off cmdk's own filtering — and the
              filtering here is ours (`shouldFilter={false}`). */}
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Spinner size="sm" />
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-4 py-4 text-center text-sm text-muted-foreground">
              {t("markdownEditor.mentionEmpty")}
            </div>
          )}
          {filtered.map((member) => (
            <CommandItem
              key={member.id}
              value={member.id}
              onSelect={() => choose(member)}
              // The caret stays in the editor; a mousedown here would blur it
              // and close the suggestion before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              className="gap-2"
            >
              <Avatar
                url={member.image ?? undefined}
                fallback={getInitials(member.name)}
                shape="circle"
                size="xs"
              />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
}
