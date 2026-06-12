/**
 * ThreadHtmlPreviews — chips for every distinct HTML artifact the model
 * has produced in this thread: decks (slides skill, org-fs home volume)
 * and legacy `pages/` HTML pages. Clicking a chip sets `?main=deck:<path>`
 * / `?main=web-page:<slug>` so the preview side-panel mounts.
 *
 * Why this exists: the preview panel is opened solely by URL state, and
 * the `data-deck-updated` / `data-html-page-published` data parts render
 * to null in the chat. Once the panel is closed (reload, manual dismiss),
 * there was no way back without URL surgery. This row is the missing
 * affordance.
 *
 * Sources: pages come from `write`/`edit` tool outputs (`htmlPreview`);
 * decks come from the persisted `data-deck-updated` parts the deck
 * watcher emits — decks can be created via bash (`slides-create`), so
 * there is no tool output to scan for them.
 */

import { useNavigate } from "@tanstack/react-router";
import { Globe01, Monitor01 } from "@untitledui/icons";
import { formatDeckTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { useOptionalChatStream } from "../context.tsx";

interface HtmlPreviewRef {
  slug: string;
  key: string;
  url: string;
  bytes: number;
}

interface DeckRef {
  path: string;
  name: string;
}

interface PreviewChip {
  /** Tab id to navigate to (`deck:…` / `web-page:…`). */
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
      const p = raw as {
        type?: string;
        state?: string;
        data?: unknown;
        output?: { htmlPreview?: HtmlPreviewRef };
      };
      if (p.type === "data-deck-updated") {
        const deck = p.data as DeckRef | undefined;
        if (!deck?.path) continue;
        const key = `deck:${deck.path}`;
        if (!seen.has(key)) {
          seen.set(key, {
            tabId: formatDeckTabId(deck.path),
            label: deck.name || deck.path,
            kind: "deck",
          });
        }
        continue;
      }
      if (p.type !== "tool-edit" && p.type !== "tool-write") continue;
      if (p.state !== "output-available") continue;
      const preview = p.output?.htmlPreview;
      if (!preview?.slug) continue;
      const key = `page:${preview.slug}`;
      if (!seen.has(key)) {
        seen.set(key, {
          tabId: `web-page:${preview.slug}`,
          label: preview.slug,
          kind: "page",
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
