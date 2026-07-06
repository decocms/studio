/**
 * Demo Mode — shared chrome for scenario stages.
 *
 * Lightweight product-like framing (preview pane) around the REAL chat.
 * Pure presentational; all live content comes from the Director's stores.
 */
import { cn } from "@deco/ui/lib/utils.ts";

/** One selectable MCP-app tab in the preview chrome (top right). */
export interface PreviewApp {
  label: string;
  active: boolean;
  onClick?: () => void;
}

/** A browser-like preview pane that renders demo HTML in an isolated iframe.
 *  `apps` renders the agent's MCP-app switcher on the toolbar's right — the
 *  current screen is explicitly ONE app UI of this agent among many, and the
 *  agent decides which apps it offers. */
export function PreviewFrame({
  url,
  html,
  apps,
}: {
  url: string;
  html: string;
  apps?: PreviewApp[];
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </span>
        <div className="ml-2 flex h-5 min-w-0 flex-1 items-center rounded-md bg-background px-2 text-[11px] text-muted-foreground">
          <span className="truncate">{url}</span>
        </div>
        {apps && (
          <div className="flex shrink-0 items-center gap-1">
            {apps.map((app) => (
              <button
                key={app.label}
                type="button"
                onClick={app.onClick}
                data-demo-target={`app:${app.label.toLowerCase()}`}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                  app.active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                )}
              >
                {app.label}
              </button>
            ))}
          </div>
        )}
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
