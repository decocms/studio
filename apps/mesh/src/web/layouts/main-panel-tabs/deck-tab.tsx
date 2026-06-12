/**
 * DeckTab — side-panel live preview + inline editor for a presentation
 * deck (`decks/<name>.html` in the org home volume, created by the
 * sandbox `slides` skill).
 *
 * The deck HTML is served same-origin from the org-fs read route and
 * rendered in a sandboxed iframe (`allow-scripts`, no same-origin — the
 * deck is member-authored content). The iframe src is keyed by the
 * file's stat marker (`size-updatedAt`), so an agent rewrite mid-run
 * (signalled via `data-deck-updated` → stat invalidation in
 * chat-context) hard-reloads the preview — except while the user is
 * editing; `useDeckEditor` owns that policy.
 *
 * While the file hasn't appeared yet (sandbox mount write-back takes a
 * few seconds for bash-created decks), the stat polls every 2s.
 */

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import { DeckToolbar } from "@/web/components/deck/deck-toolbar";
import { useDeckEditor } from "@/web/components/deck/use-deck-editor";
import { useOrgFsDownloadUrl, useOrgFsStat } from "@/web/hooks/use-org-fs";

const HOME_VOLUME = "home";
const FADE_MS = 300;

function DeckShimmer({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background">
      <Skeleton className="aspect-video w-2/3 max-w-xl" />
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}

export function DeckTab({ path }: { path: string }) {
  // Poll while the deck hasn't reached org-fs yet (rclone write-back lag
  // for bash-created decks). The query is cheap (one manifest row).
  const stat = useOrgFsStat(HOME_VOLUME, path, {
    refetchIntervalWhenAbsent: 2000,
  });
  const readUrl = useOrgFsDownloadUrl(HOME_VOLUME)(path);

  const statMarker = stat.data
    ? `${stat.data.size}-${stat.data.updatedAt}`
    : null;
  const editor = useDeckEditor({ path, readUrl, statMarker });

  // Fade the iframe in per loaded document; reset when the src rolls.
  const [readySrc, setReadySrc] = useState<string | null>(null);

  const missing = !stat.isPending && !stat.data;
  if (stat.isPending || editor.displayedMarker === null) {
    return (
      <DeckShimmer
        label={missing ? "Waiting for the deck to sync…" : undefined}
      />
    );
  }

  // Hash carries the runtime's view state (`#rail` opens the thumbnail
  // rail) — kept out of the iframe `key` so toggling it is a fragment
  // navigation inside the existing document, not a reload.
  const baseSrc = `${readUrl}&v=${encodeURIComponent(editor.displayedMarker)}`;
  const src = editor.railOpen ? `${baseSrc}#rail` : baseSrc;
  const iframeReady = readySrc === baseSrc;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DeckToolbar readUrl={readUrl} editor={editor} />
      <div className="relative flex-1">
        <iframe
          key={baseSrc}
          ref={editor.iframeRef}
          src={src}
          onLoad={() => setReadySrc(baseSrc)}
          sandbox="allow-scripts"
          className={cn(
            "absolute inset-0 block h-full w-full bg-white",
            "transition-opacity ease-out",
            iframeReady ? "opacity-100" : "opacity-0",
          )}
          style={{ transitionDuration: `${FADE_MS}ms` }}
          title={path}
        />
      </div>
    </div>
  );
}
