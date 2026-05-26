/**
 * ThreadHtmlPreviews — chips for every distinct HTML page the model
 * has produced via `write`/`edit` tools in this thread. Clicking a chip
 * sets `?main=web-page:<slug>` so the preview side-panel mounts.
 *
 * Why this exists: the preview panel is opened solely by URL state, and
 * the `data-html-page-published` data part renders to null in the chat.
 * Once the panel is closed (reload, manual dismiss), there was no way
 * back without URL surgery. This row is the missing affordance.
 */

import { useNavigate } from "@tanstack/react-router";
import { Globe01 } from "@untitledui/icons";
import { useOptionalChatStream } from "../context.tsx";

interface HtmlPreviewRef {
  slug: string;
  key: string;
  url: string;
  bytes: number;
}

function collectPreviews(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
): HtmlPreviewRef[] {
  // Walk in reverse so the latest publish per slug wins on dedup.
  const seen = new Map<string, HtmlPreviewRef>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (const raw of parts) {
      const p = raw as {
        type?: string;
        state?: string;
        output?: { htmlPreview?: HtmlPreviewRef };
      };
      if (p.type !== "tool-edit" && p.type !== "tool-write") continue;
      if (p.state !== "output-available") continue;
      const preview = p.output?.htmlPreview;
      if (!preview?.slug) continue;
      if (!seen.has(preview.slug)) seen.set(preview.slug, preview);
    }
  }
  return Array.from(seen.values());
}

export function ThreadHtmlPreviews() {
  const navigate = useNavigate();
  const messages = useOptionalChatStream()?.messages ?? [];
  const previews = collectPreviews(messages);

  if (previews.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="text-[12px] text-muted-foreground/70 uppercase tracking-wide">
        Pages in this chat
      </div>
      <div className="flex flex-wrap gap-2">
        {previews.map((preview) => (
          <button
            type="button"
            key={preview.slug}
            onClick={() =>
              navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  main: `web-page:${preview.slug}`,
                }),
                replace: true,
              })
            }
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 text-[13px] transition-colors"
          >
            <Globe01 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{preview.slug}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
