/**
 * ThreadHtmlPreviews — chips for every distinct HTML artifact the model has
 * produced in this thread: decks (`decks/`) and pages (`pages/`) in the org
 * home volume. Clicking a chip sets `?main=deck:<path>` so the preview
 * side-panel mounts.
 *
 * Why this exists: the preview panel is opened solely by URL state, and the
 * `data-deck-updated` data part renders to null in the chat. Once the panel
 * is closed (reload, manual dismiss), there was no way back without URL
 * surgery. This row is the missing affordance.
 *
 * Source: the persisted `data-deck-updated` parts the html-artifact watcher
 * emits — artifacts can be created via bash (`slides-create`), so there is no
 * tool output to scan for them.
 */

import { useNavigate } from "@tanstack/react-router";
import { Globe01, Monitor01 } from "@untitledui/icons";
import { formatDeckTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useOptionalChatStream } from "../context.tsx";

interface DeckRef {
  path: string;
  name: string;
  /** `deck` (decks/) or `page` (pages/); older parts may omit it. */
  kind?: "deck" | "page";
}

interface PreviewChip {
  /** Tab id to navigate to (`deck:…`). */
  tabId: string;
  label: string;
  kind: "deck" | "page";
}

function collectChips(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
): PreviewChip[] {
  // Walk in reverse so the latest artifact per key wins on dedup.
  const seen = new Map<string, PreviewChip>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (const raw of parts) {
      const p = raw as { type?: string; data?: unknown };
      if (p.type !== "data-deck-updated") continue;
      const deck = p.data as DeckRef | undefined;
      if (!deck?.path) continue;
      const key = `deck:${deck.path}`;
      if (!seen.has(key)) {
        seen.set(key, {
          tabId: formatDeckTabId(deck.path),
          label: deck.name || deck.path,
          kind: deck.kind === "page" ? "page" : "deck",
        });
      }
    }
  }
  return Array.from(seen.values());
}

export function ThreadHtmlPreviews() {
  const navigate = useNavigate();
  const messages = useOptionalChatStream()?.messages ?? [];
  const chips = collectChips(messages);

  if (chips.length === 0) return null;

  const hasDecks = chips.some((c) => c.kind === "deck");
  const hasPages = chips.some((c) => c.kind === "page");
  const heading = hasDecks
    ? hasPages
      ? "Slides & pages in this chat"
      : "Slides in this chat"
    : "Pages in this chat";

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="text-[12px] text-muted-foreground/70 uppercase tracking-wide">
        {heading}
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            type="button"
            key={chip.tabId}
            onClick={() =>
              navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  main: chip.tabId,
                }),
                replace: true,
              })
            }
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 text-[13px] transition-colors"
          >
            {chip.kind === "deck" ? (
              <Monitor01 className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Globe01 className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium text-foreground">{chip.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
