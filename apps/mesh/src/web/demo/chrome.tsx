/**
 * Demo Mode — shared chrome for scenario stages.
 *
 * Lightweight product-like framing (preview pane) around the REAL chat.
 * Pure presentational; all live content comes from the Director's stores.
 */

/** A browser-like preview pane that renders demo HTML in an isolated iframe. */
export function PreviewFrame({ url, html }: { url: string; html: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </span>
        <div className="ml-2 flex h-5 flex-1 items-center rounded-md bg-background px-2 text-[11px] text-muted-foreground">
          {url}
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-white">
        {html ? (
          // key on html → each preview change fades in (masks the srcDoc swap)
          <iframe
            key={html}
            title={url}
            srcDoc={html}
            className="size-full border-0 animate-in fade-in duration-700"
            sandbox=""
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading preview…
          </div>
        )}
      </div>
    </div>
  );
}
