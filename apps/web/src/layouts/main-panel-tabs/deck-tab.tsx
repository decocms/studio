/**
 * DeckTab — side-panel preview/editor for an org-fs home-volume HTML file
 * (`decks/<name>.html`, created by the sandbox `slides` skill).
 *
 * Thin adapter: resolves the same-origin read URL + stat marker and
 * renders the shared HtmlPreviewPanel, which upgrades into the deck
 * editor when the document completes the deck-viewer handshake. The
 * `savePath` makes the source writable (inline edits PUT back to org-fs;
 * a UI write reaches the sandbox mount in ~1s, so the agent sees it).
 *
 * Stat invalidation arrives from chat-context on `data-deck-updated`
 * parts (agent rewrites mid-run); while the file hasn't appeared yet
 * (sandbox mount write-back takes a few seconds for bash-created decks),
 * the stat polls every 2s.
 */

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { HtmlPreviewPanel } from "@/components/deck/html-preview-panel";
import {
  entryMarker,
  useOrgFsDownloadUrl,
  useOrgFsStat,
} from "@/hooks/use-org-fs";
import { FileShareButton } from "@/layouts/library/file-share-button";
import { useChatTask } from "@/components/chat/context";

const HOME_VOLUME = "home";

function DeckShimmer({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background">
      <Skeleton className="aspect-video w-2/3 max-w-xl" />
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}

export function DeckTab({ path }: { path: string }) {
  const { canMutateThread } = useChatTask();
  const stat = useOrgFsStat(HOME_VOLUME, path, {
    refetchIntervalWhenAbsent: 2000,
  });
  const readUrl = useOrgFsDownloadUrl(HOME_VOLUME)(path);

  if (stat.isPending || !stat.data) {
    return (
      <DeckShimmer
        label={
          !stat.isPending && !stat.data
            ? "Waiting for the deck to sync…"
            : undefined
        }
      />
    );
  }

  return (
    <HtmlPreviewPanel
      readUrl={readUrl}
      marker={entryMarker(stat.data)}
      title={path}
      savePath={canMutateThread ? path : undefined}
      trailing={
        canMutateThread ? (
          <FileShareButton
            volume={HOME_VOLUME}
            path={path}
            shareMode={stat.data.shareMode ?? "private"}
            effectivePublic={stat.data.effectivePublic ?? false}
            url={window.location.origin + readUrl}
          />
        ) : undefined
      }
    />
  );
}
