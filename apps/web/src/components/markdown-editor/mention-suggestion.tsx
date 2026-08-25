/**
 * The `@` picker: a Tiptap suggestion plugin and the menu it drives.
 *
 * The plugin lives in ProseMirror and the menu in React, so they meet at a
 * tiny store rather than a portal rendered from inside the plugin — one
 * component tree, one place the menu's state can be read.
 *
 * The menu is a plain shadcn `Command`, doing its whole job: its own search
 * input, its own filtering, its own arrow-key selection and scrolling. Opening
 * it moves focus into that input, so while the picker is up the keystrokes are
 * cmdk's and the editor sees none of them. Nothing here re-implements a
 * listbox.
 */

import { useState, useSyncExternalStore } from "react";
import Suggestion, {
  exitSuggestion,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { createPortal } from "react-dom";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
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
 * because the plugin's callbacks fire outside React's tree, and the menu has
 * to see an open/close the moment it happens.
 */
export class MentionMenuStore {
  private state: MenuState = CLOSED;
  private listeners = new Set<() => void>();
  /** The `@` the user dismissed, if any. See `dismiss`. */
  dismissal: Dismissal | null = null;

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
  // Plain exit, not `dismiss`: the `@query` this replaced is gone, so there is
  // no trigger left to keep suppressed.
  exitSuggestion(editor.view, MENTION_SUGGESTION_KEY);
}

/** A dismissed trigger: where the `@` sits, and the text matched at the time. */
interface Dismissal {
  from: number;
  text: string;
}

/** The text at `from`, as long as `length`, clamped to the document. */
function textAt(doc: Node, from: number, length: number): string {
  const to = Math.min(from + length, doc.content.size);
  return from >= to ? "" : doc.textBetween(from, to, "\ufffc", "\ufffc");
}

/**
 * Dismiss the picker for good — not just for one transaction.
 *
 * `exitSuggestion` clears the plugin's state, but the plugin re-runs its match
 * on EVERY transaction, so the next one (returning focus to the editor is one)
 * finds the same `@` still sitting there and reopens. Remembering which `@` was
 * dismissed is what `allow` below consults to keep it shut.
 */
function dismiss(editor: Editor, store: MentionMenuStore) {
  const state = MENTION_SUGGESTION_KEY.getState(editor.state) as
    | { range?: { from: number; to: number } }
    | undefined;
  const range = state?.range;
  if (range && range.to > range.from) {
    store.dismissal = {
      from: range.from,
      text: editor.state.doc.textBetween(range.from, range.to, "\ufffc"),
    };
  }
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
        // Keeps a dismissed `@` dismissed. Still matching means still claiming
        // Enter, so without this an Escape'd picker both reopens and swallows
        // the next send. Self-clearing: once the text at that spot is no longer
        // what was dismissed (the `@` was deleted, say), the trigger is live
        // again — typing MORE after it is not, which is the behaviour everyone
        // else's `@` menu has.
        allow: ({ state, range }) => {
          const dismissed = store.dismissal;
          if (!dismissed) return true;
          if (
            range.from === dismissed.from &&
            textAt(state.doc, dismissed.from, dismissed.text.length) ===
              dismissed.text
          ) {
            return false;
          }
          store.dismissal = null;
          return true;
        },
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
          // The menu's input holds focus while it's open, so these keys only
          // arrive in the gap before that lands — or if focusing failed.
          onKeyDown: ({ event }) => {
            if (event.key === "Escape") {
              dismiss(this.editor, store);
              store.close();
              return true;
            }
            return false;
          },
          onExit: () => store.close(),
        }),
      };
      return [Suggestion(options)];
    },
  });
}

const MENU_WIDTH = 256;
/** `CommandInput`'s own fixed height — the list gets what's left. */
const INPUT_HEIGHT = 40;
const MENU_MAX_HEIGHT = 280;
const MENU_MIN_HEIGHT = 140;

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
  // Controlled, so the field can be seeded with whatever reached the editor
  // before focus landed here — cmdk's input owns its own state otherwise.
  const [query, setQuery] = useState(state.query);

  // Fixed to the caret's own rect, in a body portal so the editor's overflow
  // can't clip it. Full floating-ui placement would buy collision detection
  // against every edge; the only edge a menu under a caret actually hits is
  // the bottom of the viewport, and that's the flip below.
  const caret = state.rect?.() ?? new DOMRect(0, 0, 0, 0);
  const below = window.innerHeight - caret.bottom;
  const flipUp = below < MENU_MAX_HEIGHT && caret.top > below;
  // The cap the LIST scrolls within, never the wrapper's: a wrapper that clips
  // (it has to, for the rounded corners) shorter than the list's own scroll
  // container just hides the overflow instead of scrolling it.
  const listMaxHeight =
    Math.max(flipUp ? caret.top - 8 : below - 8, MENU_MIN_HEIGHT) -
    INPUT_HEIGHT;
  const style: React.CSSProperties = {
    position: "fixed",
    width: MENU_WIDTH,
    left: Math.min(caret.left, window.innerWidth - MENU_WIDTH - 8),
    ...(flipUp
      ? { bottom: window.innerHeight - caret.top + 6 }
      : { top: caret.bottom + 6 }),
  };

  /** End the match and put the menu away. Focus is the caller's business. */
  const close = () => {
    if (state.editor) dismiss(state.editor, store);
    store.close();
  };

  const choose = (member: MentionMember) => {
    if (!state.editor || !state.range) return;
    insert(state.editor, state.range, member);
    store.close();
  };

  return createPortal(
    <div
      style={style}
      data-testid="mention-menu"
      className="z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-md"
    >
      <Command
        // cmdk filters, selects and scrolls; `members` is just the source.
        // The one thing it can't know is that Escape has to hand focus back
        // to the editor and end the plugin's match, not merely hide a list.
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          close();
          // Escape means "back to what I was writing", so the caret goes back
          // with it. A click elsewhere (below) doesn't — that focus is the
          // user's own choice, and stealing it back would fight the click.
          state.editor?.commands.focus();
        }}
      >
        <CommandInput
          // Focus moves here on open, so the query is typed into the search
          // field rather than into the document behind it. Seeded with
          // whatever reached the editor before focus landed.
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t("markdownEditor.mentionSearch")}
          // Clicking away is a dismissal — without this the menu outlives the
          // caret it belongs to.
          onBlur={close}
        />
        <CommandList style={{ maxHeight: listMaxHeight }}>
          {/* A cached list is on screen while the refresh runs; the spinner is
              only for the first ever open, with nothing to show. */}
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : (
            <CommandEmpty>{t("markdownEditor.mentionEmpty")}</CommandEmpty>
          )}
          {members.map((member) => (
            <CommandItem
              key={member.id}
              // What cmdk searches on — the name AND the email, so either
              // finds a teammate. `onSelect` closes over the member itself,
              // so the id never has to survive this string.
              value={`${member.name} ${member.email}`}
              onSelect={() => choose(member)}
              // The input is what holds focus; a mousedown here would blur it
              // and fire the dismissal above before the click ever lands.
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
