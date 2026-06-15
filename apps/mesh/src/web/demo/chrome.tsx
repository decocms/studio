/**
 * Demo Mode — shared chrome for scenario stages.
 *
 * Lightweight product-like framing (top bar, preview pane) around the REAL
 * chat. Pure presentational; all live content comes from the Director's stores.
 */

export function DemoTopBar({
  org,
  agent,
  left,
  right,
}: {
  org: string;
  agent: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex size-6 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background">
        {org.slice(0, 1)}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-foreground">{org}</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-sm text-muted-foreground">{agent}</span>
      </div>
      {left}
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </header>
  );
}

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
          <iframe
            title={url}
            srcDoc={html}
            className="size-full border-0"
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
