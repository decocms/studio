/**
 * WebPageTab — side-panel preview of a generated HTML page (the legacy
 * `pages/<slug>.html` pipeline).
 *
 * The HTML itself is NOT streamed through the chat. The model writes to
 * the sandbox; the wrapped `write`/`edit` tools enqueue the new content
 * into a per-turn buffer (`html-page-buffer`) and the actual S3 PUT
 * happens once per step. This component waits for the
 * `data-html-page-published` part emitted after the PUT lands (loading
 * the URL straight from the tool result would race the deferred PUT),
 * then renders the shared HtmlPreviewPanel.
 *
 * The panel is the same surface decks use: if the published page speaks
 * the deck-viewer protocol it gains the rail toggle + PDF export. No
 * `savePath` — this pipeline's source of truth is the sandbox file, and
 * there is no write-back route to object storage, so the preview stays
 * read-only (no inline edit affordance).
 *
 * Cache-bust: the publish event's byte count is the content marker; a
 * republished slug with a different size rolls the iframe src.
 */

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { useOptionalChatStream } from "@/web/components/chat/context.tsx";
import { HtmlPreviewPanel } from "@/web/components/deck/html-preview-panel";

interface HtmlPagePublished {
  slug: string;
  key: string;
  url: string;
  bytes: number;
}

function PageShimmer() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white">
      <div className="flex w-3/4 max-w-md flex-col gap-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="mt-2 h-8 w-24" />
      </div>
    </div>
  );
}

interface UnknownPart {
  type?: string;
  data?: unknown;
}

/**
 * Scan messages newest-first for the latest `data-html-page-published`
 * part whose `data.slug` matches. Bursts of write/edit calls collapse to
 * one published event per step; iteration ("update the page") naturally
 * surfaces the most recent published event.
 */
function findLatestPublished(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
  slug: string,
): HtmlPagePublished | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const raw = parts[j] as UnknownPart | null;
      if (!raw || raw.type !== "data-html-page-published") continue;
      const data = raw.data as HtmlPagePublished | undefined;
      if (!data) continue;
      if (data.slug === slug) return data;
    }
  }
  return null;
}

export function WebPageTab({ slug }: { slug: string }) {
  const stream = useOptionalChatStream();
  const messages = stream?.messages ?? [];
  const latest = findLatestPublished(messages, slug);

  if (!latest) {
    return (
      <div className="h-full w-full bg-background">
        <PageShimmer />
      </div>
    );
  }

  return (
    <HtmlPreviewPanel
      key={slug}
      readUrl={latest.url}
      marker={String(latest.bytes)}
      title={`${slug}.html`}
    />
  );
}
