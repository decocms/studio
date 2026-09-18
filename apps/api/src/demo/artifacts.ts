import type { DemoBundle } from "./bundle";
import type { DemoRecipe } from "@decocms/shared/demo";

export function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function changePage(bundle: DemoBundle, recipe: DemoRecipe) {
  const data = bundle.recipes[recipe];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.title)}</title><style>body{font:15px system-ui;margin:40px;line-height:1.6}pre{white-space:pre-wrap;background:#f4f4f4;padding:24px}h1{font-size:24px}</style></head><body><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(bundle.source.repository)} · ${escapeHtml(bundle.source.commit)}</p><p>${escapeHtml(data.result)}</p><pre>${escapeHtml(data.diff)}</pre></body></html>`;
}
