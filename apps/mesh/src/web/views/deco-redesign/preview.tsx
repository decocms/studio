/**
 * Preview (mock)
 *
 * Mirrors the real sandbox preview (components/sandbox/preview/preview.tsx):
 * a toolbar with the ViewModeToggle (Interactive / Visual / Sections / Code),
 * a refresh + pages URL-bar dropdown, and open-in-new-tab + more menu. The real
 * one steers a live dev-server iframe from a running sandbox; this renders a
 * self-contained mock storefront instead. Mock only.
 */

import { useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Code02,
  CursorClick01,
  DotsHorizontal,
  LinkExternal01,
  Monitor04,
  RefreshCw01,
  TextInput,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ViewModeToggle,
  type ViewModeOption,
} from "@deco/ui/components/view-mode-toggle.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { DecoMark } from "./primitives";

const STOREFRONT = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { color: #18181b; background: #fff; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 32px; border-bottom: 1px solid #ececec; }
  .logo { font-weight: 700; letter-spacing: -0.02em; }
  nav a { margin-left: 20px; color: #52525b; text-decoration: none; font-size: 14px; }
  .hero { padding: 64px 32px; text-align: center; background: #f6f6f4; }
  .hero h1 { font-size: 40px; letter-spacing: -0.03em; }
  .hero p { margin-top: 12px; color: #52525b; }
  .btn { display: inline-block; margin-top: 24px; padding: 12px 24px; background: #18181b; color: #fff; border-radius: 999px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 40px 32px; }
  .card { border: 1px solid #ececec; border-radius: 14px; overflow: hidden; }
  .ph { aspect-ratio: 4/3; background: linear-gradient(135deg,#eee,#f6f6f4); }
  .meta { padding: 12px 14px; }
  .meta b { font-size: 14px; }
  .meta span { display: block; margin-top: 4px; color: #71717a; font-size: 13px; }
</style></head>
<body>
  <header>
    <div class="logo">STOREFRONT</div>
    <nav><a>New in</a><a>Dresses</a><a>Sale</a><a>About</a></nav>
  </header>
  <section class="hero">
    <h1>Summer, in full bloom</h1>
    <p>The new collection just landed.</p>
    <div class="btn">Shop the drop</div>
  </section>
  <section class="grid">
    <div class="card"><div class="ph"></div><div class="meta"><b>Linen midi dress</b><span>$148</span></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><b>Printed scarf</b><span>$42</span></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><b>Straw tote</b><span>$96</span></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><b>Cotton shirt</b><span>$78</span></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><b>Wide-leg pants</b><span>$112</span></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><b>Leather sandals</b><span>$134</span></div></div>
  </section>
</body></html>`;

/** The chat panel that sits beside the preview — talk to Deco while you watch
 *  the storefront change. Mock conversation + composer. */
export function PreviewChat() {
  const [input, setInput] = useState("");
  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-l border-border">
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4 text-sm">
        <div className="flex gap-2.5">
          <DecoMark className="mt-0.5 size-5 shrink-0" />
          <p className="leading-relaxed text-foreground">
            I shipped the new homepage hero — it's on the left. Want me to push
            it live?
          </p>
        </div>
        <p className="ml-auto max-w-[80%] rounded-2xl bg-muted px-3 py-2 leading-relaxed text-foreground">
          Looks good, but make the headline bigger.
        </p>
        <div className="flex gap-2.5">
          <DecoMark className="mt-0.5 size-5 shrink-0" />
          <p className="leading-relaxed text-foreground">
            Done — bumped the hero headline to 48px. Refresh the preview to see
            it.
          </p>
        </div>
      </div>
      <div className="p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 pl-3.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={1}
            placeholder="Ask Deco to change the storefront..."
            className="max-h-32 min-h-6 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <Button size="icon" className="size-8 shrink-0 rounded-full">
            <ArrowUp size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}

type ViewMode = "preview" | "visual" | "cms" | "code";

const VIEW_MODE_OPTIONS: ViewModeOption<ViewMode>[] = [
  { value: "preview", icon: <Monitor04 size={14} />, tooltip: "Interactive" },
  {
    value: "visual",
    icon: <CursorClick01 size={14} />,
    tooltip: "Visual editor",
  },
  { value: "cms", icon: <TextInput size={14} />, tooltip: "Sections editor" },
  { value: "code", icon: <Code02 size={14} />, tooltip: "Code editor" },
];

const PAGES = [
  { name: "Home", path: "/" },
  { name: "New in", path: "/new-in" },
  { name: "Dresses", path: "/dresses" },
  { name: "Sale", path: "/sale" },
  { name: "About", path: "/about" },
];

export function PreviewView() {
  const { org } = useProjectContext();
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [path, setPath] = useState("/");
  const host = `${org.slug}.deco.site`;
  const page = PAGES.find((p) => p.path === path);
  const label = `${host}${path === "/" ? "" : path}`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Toolbar — mirrors the sandbox preview */}
      <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border/60 px-3 md:px-4">
        <ViewModeToggle
          value={viewMode}
          onValueChange={setViewMode}
          options={VIEW_MODE_OPTIONS}
          size="sm"
          className="shrink-0 bg-foreground/4.5"
        />

        {viewMode !== "code" && (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
              <Button variant="ghost" size="icon" aria-label="Refresh">
                <RefreshCw01 size={14} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-full min-w-0 items-center gap-1 rounded-md bg-background px-2 transition-colors duration-200 hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground/88">
                      {label}
                    </span>
                    {page && (
                      <span className="shrink-0 text-[12px] text-muted-foreground">
                        {page.name}
                      </span>
                    )}
                    <ChevronDown
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {PAGES.map((p) => (
                    <DropdownMenuItem
                      key={p.path}
                      className="gap-3"
                      onClick={() => setPath(p.path)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {p.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {p.path}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button variant="ghost" size="icon" aria-label="Open in new tab">
                <LinkExternal01 size={14} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More">
                    <DotsHorizontal size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>Hard reload</DropdownMenuItem>
                  <DropdownMenuItem>Copy current URL</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>

      {/* Body */}
      <div className="relative flex-1 overflow-hidden">
        {viewMode === "visual" && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex -translate-x-1/2 select-none items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/90 px-3 py-1 text-xs font-medium text-white shadow-md backdrop-blur-sm">
            <CursorClick01 size={12} />
            Click any element to ask the AI
          </div>
        )}
        {viewMode === "code" ? (
          <pre className="h-full overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
            {STOREFRONT}
          </pre>
        ) : (
          <iframe
            title="Storefront preview"
            srcDoc={STOREFRONT}
            className="size-full border-0 bg-background"
          />
        )}
      </div>
    </div>
  );
}
