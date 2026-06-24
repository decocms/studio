/**
 * Brand components viewer — renders a sheet of UI primitives (buttons, card,
 * input, badges, chips) styled entirely with the brand's `--brand-*` tokens,
 * so you can see the brand applied beyond the deck. Read-only.
 *
 * Like the deck viewer, it composes a self-contained HTML doc — the live
 * tokens.css inlined + a fixed component stylesheet that maps onto the tokens
 * (with sane fallbacks for minimal brands) — and renders it in a fully
 * sandboxed `srcDoc` iframe (static HTML, no scripts). Shares the fileText
 * cache, so a brand save re-renders it.
 */

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { KEYS } from "@/web/lib/query-keys";

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.text();
}

// Maps generic primitives onto --brand-* tokens; fallbacks keep a minimal
// brand (just primary + a couple colors) looking intentional.
const COMPONENT_STYLES = `
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--brand-bg,#0b0f1a);color:var(--brand-fg,#f5f7ff);font-family:var(--brand-font-body,system-ui,sans-serif);font-size:14px;line-height:1.5}
  .stack{display:flex;flex-direction:column;gap:18px;max-width:760px}
  .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  h1{font-family:var(--brand-font-display,inherit);font-size:28px;font-weight:700;letter-spacing:-0.02em;margin:0}
  .muted{color:var(--brand-fg-muted,#9fb0c9)}
  .btn{border:0;border-radius:var(--brand-radius,12px);padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}
  .btn-primary{background:var(--brand-primary,#0a84ff);color:#fff}
  .btn-secondary{background:transparent;color:var(--brand-fg,#f5f7ff);border:1.5px solid var(--brand-border-strong,rgba(255,255,255,.22))}
  .btn-ghost{background:transparent;color:var(--brand-fg-muted,#9fb0c9)}
  .card{background:var(--brand-bg-subtle,#121826);border:1px solid var(--brand-border,rgba(255,255,255,.1));border-radius:var(--brand-radius-lg,16px);padding:20px;box-shadow:var(--brand-shadow-md,0 6px 16px rgba(8,12,22,.45))}
  .kpi{font-family:var(--brand-font-display,inherit);font-size:44px;font-weight:700;color:var(--brand-primary,#0a84ff);line-height:1;letter-spacing:-0.02em}
  .input{width:100%;background:var(--brand-bg-elevated,#1a2233);border:1.5px solid var(--brand-border,rgba(255,255,255,.12));border-radius:var(--brand-radius,12px);padding:10px 12px;color:inherit;font:inherit}
  .badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}
  .badge-success{background:var(--brand-success-bg,#e7f6ec);color:var(--brand-success-fg,#0f7a37)}
  .badge-warning{background:var(--brand-warning-bg,#fdf3d6);color:var(--brand-warning-fg,#8a6500)}
  .badge-error{background:var(--brand-error-bg,#fde7e8);color:var(--brand-error-fg,#b01319)}
  .badge-info{background:var(--brand-info-bg,#e8f1ff);color:var(--brand-info-fg,#0b54a8)}
  .chip{border:1.5px solid var(--brand-border-strong,rgba(255,255,255,.22));border-radius:999px;padding:6px 14px;font-size:13px}
  .chip-active{background:var(--brand-primary,#0a84ff);border-color:transparent;color:#fff}
`;

const COMPONENT_BODY = `
  <div class="stack">
    <div>
      <h1>Your brand, applied</h1>
      <p class="muted" style="margin:6px 0 0">Buttons, cards, inputs and badges in your tokens.</p>
    </div>
    <div class="row">
      <button class="btn btn-primary">Primary</button>
      <button class="btn btn-secondary">Secondary</button>
      <button class="btn btn-ghost">Ghost</button>
    </div>
    <div class="card">
      <p class="muted" style="margin:0 0 6px">Monthly savings</p>
      <div class="kpi">$240</div>
    </div>
    <input class="input" placeholder="you@example.com" />
    <div class="row">
      <span class="badge badge-success">Success</span>
      <span class="badge badge-warning">Warning</span>
      <span class="badge badge-error">Error</span>
      <span class="badge badge-info">Info</span>
    </div>
    <div class="row">
      <span class="chip chip-active">All</span>
      <span class="chip">Income</span>
      <span class="chip">Spending</span>
    </div>
  </div>
`;

function composeComponentsPreview(tokensCss: string | null): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>${tokensCss ?? ""}</style><style>${COMPONENT_STYLES}</style></head><body>${COMPONENT_BODY}</body></html>`;
}

export function BrandComponentsPreview({ tokensUrl }: { tokensUrl?: string }) {
  const tokens = useQuery({
    queryKey: KEYS.fileText(tokensUrl ?? ""),
    enabled: !!tokensUrl,
    queryFn: () => fetchText(tokensUrl ?? ""),
    staleTime: 60_000,
    retry: false,
  });

  if (tokensUrl && tokens.isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    );
  }

  return (
    <iframe
      title="Brand components"
      srcDoc={composeComponentsPreview(tokens.data ?? null)}
      sandbox=""
      className="block h-full w-full border-0 bg-white"
    />
  );
}
