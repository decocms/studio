/**
 * Deck-theme viewer — a read-only glance of a brand's `slides-theme.html` in
 * the brand style. A theme is either a real deck (its own `<section>`s — the
 * deck-as-theme convention) or a legacy Mustache shell (`{{{slides}}}`); for
 * the shell we fill the slot with bundled sample sections, for a real deck the
 * fill is a no-op and its own slides render. Either way it renders in a
 * sandboxed `srcDoc` iframe driven by the same /deck-runtime/v1 viewer.
 * `srcDoc`'s document URL is `about:srcdoc`, so the runtime's root-absolute
 * `<script src="/deck-runtime/…">` is rewritten to an absolute origin URL.
 *
 * The theme bakes a snapshot of its `--brand-*` tokens. When a live
 * `tokensUrl` is given we fetch the current tokens.css and inject it as a
 * trailing `<style>` so the preview reflects edits to tokens.css (later
 * `:root` wins) instead of the frozen copy — invalidating that file's
 * fileText query (e.g. after a brand save) re-renders the deck.
 */

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { KEYS } from "@/lib/query-keys";
import { DECK_SAMPLE_SECTIONS, DECK_SAMPLE_TITLE } from "./deck-theme-sample";

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.text();
}

function composeThemePreview(
  themeHtml: string,
  liveTokens: string | null,
): string {
  const tokenStyle = liveTokens ? `<style>${liveTokens}</style>` : "";
  return (
    themeHtml
      .replaceAll("{{{slides}}}", DECK_SAMPLE_SECTIONS)
      .replaceAll("{{title}}", DECK_SAMPLE_TITLE)
      // srcDoc origin is about:srcdoc — make the viewer runtime load absolute.
      .replace(/(src=")(\/deck-runtime\/)/g, `$1${window.location.origin}$2`)
      // Live tokens override the theme's baked snapshot (later :root wins).
      .replace("</head>", `${tokenStyle}</head>`)
  );
}

export function DeckThemePreview({
  readUrl,
  title,
  tokensUrl,
}: {
  /** Same-origin byte URL of the theme file. */
  readUrl: string;
  title: string;
  /** Optional sibling tokens.css URL — injected live over the baked copy. */
  tokensUrl?: string;
}) {
  const theme = useQuery({
    queryKey: KEYS.fileText(readUrl),
    queryFn: () => fetchText(readUrl),
    staleTime: 60_000,
    retry: false,
  });
  // Optional and best-effort: a missing tokens.css just falls back to the
  // theme's baked snapshot. Shares the fileText cache/key with the brand
  // editor, so a brand save invalidates and re-renders this preview.
  const tokens = useQuery({
    queryKey: KEYS.fileText(tokensUrl ?? ""),
    enabled: !!tokensUrl,
    queryFn: () => fetchText(tokensUrl ?? ""),
    staleTime: 60_000,
    retry: false,
  });

  if (theme.isPending || (!!tokensUrl && tokens.isPending)) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Skeleton className="aspect-[16/9] w-full max-w-3xl rounded-xl" />
      </div>
    );
  }
  if (theme.isError || !theme.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This theme is no longer available.
      </div>
    );
  }

  return (
    <iframe
      title={title}
      srcDoc={composeThemePreview(theme.data, tokens.data ?? null)}
      sandbox="allow-scripts"
      className="block h-full w-full border-0 bg-white"
    />
  );
}
