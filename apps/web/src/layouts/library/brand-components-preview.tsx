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

import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { useFileText } from "@/hooks/use-org-fs";

function createComponentBody(t: TFunction): string {
  const brandApplied = t("library.brandComponentsPreview.title");
  const buttonsCardsInputs = t("library.brandComponentsPreview.subtitle");
  const monthlySavings = t(
    "library.brandComponentsPreview.monthlySavingsLabel",
  );
  const primaryBtn = t("library.brandComponentsPreview.primaryButton");
  const secondaryBtn = t("library.brandComponentsPreview.secondaryButton");
  const ghostBtn = t("library.brandComponentsPreview.ghostButton");
  const successBadge = t("library.brandComponentsPreview.successBadge");
  const warningBadge = t("library.brandComponentsPreview.warningBadge");
  const errorBadge = t("library.brandComponentsPreview.errorBadge");
  const infoBadge = t("library.brandComponentsPreview.infoBadge");
  const allChip = t("library.brandComponentsPreview.allChip");
  const incomeChip = t("library.brandComponentsPreview.incomeChip");
  const spendingChip = t("library.brandComponentsPreview.spendingChip");
  const emailPlaceholder = t("library.brandComponentsPreview.emailPlaceholder");

  return `
  <div class="stack">
    <div>
      <h1>${brandApplied}</h1>
      <p class="muted" style="margin:6px 0 0">${buttonsCardsInputs}</p>
    </div>
    <div class="row">
      <button class="btn btn-primary">${primaryBtn}</button>
      <button class="btn btn-secondary">${secondaryBtn}</button>
      <button class="btn btn-ghost">${ghostBtn}</button>
    </div>
    <div class="card">
      <p class="muted" style="margin:0 0 6px">${monthlySavings}</p>
      <div class="kpi">$240</div>
    </div>
    <input class="input" placeholder="${emailPlaceholder}" />
    <div class="row">
      <span class="badge badge-success">${successBadge}</span>
      <span class="badge badge-warning">${warningBadge}</span>
      <span class="badge badge-error">${errorBadge}</span>
      <span class="badge badge-info">${infoBadge}</span>
    </div>
    <div class="row">
      <span class="chip chip-active">${allChip}</span>
      <span class="chip">${incomeChip}</span>
      <span class="chip">${spendingChip}</span>
    </div>
  </div>
`;
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

function composeComponentsPreview(
  tokensCss: string | null,
  componentBody: string,
): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>${tokensCss ?? ""}</style><style>${COMPONENT_STYLES}</style></head><body>${componentBody}</body></html>`;
}

export function BrandComponentsPreview({ tokensUrl }: { tokensUrl?: string }) {
  const t = useT();
  const tokens = useFileText(tokensUrl ?? "");

  if (tokensUrl && tokens.isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    );
  }

  const iframeTitle = t("library.brandComponentsPreview.iframeTitle");
  const componentBody = createComponentBody(t);

  return (
    <iframe
      title={iframeTitle}
      srcDoc={composeComponentsPreview(tokens.data ?? null, componentBody)}
      sandbox=""
      className="block h-full w-full border-0 bg-white"
    />
  );
}
