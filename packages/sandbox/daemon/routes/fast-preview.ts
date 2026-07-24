import { join } from "node:path";
import type { TenantConfigStore } from "../config-store";
import { generateDecofileFromBlocksDeduped } from "./fs";

interface FastPreviewDeps {
  repoDir: string;
  store: TenantConfigStore;
}

/**
 * `GET /_deco/fast-preview?component=<blockKey>&path=<path>&pathTemplate=<t>`
 *
 * Renders the working-tree DRAFT without the dev server: merge `.deco/blocks/*`
 * into a decofile, POST it to the linked site's production `/live/previews/<component>`
 * (the always-on deco runtime), and return the HTML with a `<base>` pointing at
 * production so the storefront's assets/relative URLs resolve there instead of
 * against the daemon origin the frame is served from.
 *
 * Public (browser-reachable, like the dev-server proxy) — it exposes the same
 * draft content the dev server would. All work is async (fs + fetch), and the
 * decofile is forwarded as raw text (no multi-MB `JSON.parse`) to respect the
 * daemon's single-thread budget (CONTRIBUTING rule #4).
 */
export function makeFastPreviewHandler(deps: FastPreviewDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const app = deps.store.read()?.application;
    const productionUrl = app?.productionUrl;
    if (!productionUrl) {
      return text("Fast Preview is not configured (no production URL).", 400);
    }
    const component = url.searchParams.get("component") ?? "";
    if (!component) return text("Missing ?component", 400);

    const path = url.searchParams.get("path") || "/";
    const pathTemplate = url.searchParams.get("pathTemplate") || path;

    // `.deco/blocks` lives under the package path (the dev-script cwd) when the
    // project isn't at the repo root; the daemon resolves against repoDir.
    const packagePath = app?.packageManager?.path ?? "";
    const blocksDir = join(deps.repoDir, packagePath, ".deco", "blocks");
    const decofile = await generateDecofileFromBlocksDeduped(blocksDir);
    if (!decofile) return text("No .deco/blocks to preview.", 404);

    // Forward the decofile as raw text — `generateDecofileFromBlocks` already
    // returns a JSON object string, so wrap it without re-parsing.
    const body = `{"__decofile":${decofile}}`;
    const target = new URL(
      `/live/previews/${encodeURIComponent(component)}`,
      productionUrl,
    );
    target.searchParams.set("path", path);
    target.searchParams.set("pathTemplate", pathTemplate);
    const deviceHint = url.searchParams.get("deviceHint");
    if (deviceHint) target.searchParams.set("deviceHint", deviceHint);

    let rendered: Response;
    try {
      rendered = await fetch(target.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (e) {
      return text(`Fast Preview render failed: ${(e as Error).message}`, 502);
    }
    if (!rendered.ok) {
      return text(
        `Production /live/previews returned ${rendered.status}.`,
        502,
      );
    }
    const html = await rendered.text();
    const base = `<base href="${productionUrl.replace(/\/?$/, "/")}">`;
    return new Response(injectBase(html, base), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Insert `base` right after the opening `<head>` (or prepend if there is none). */
function injectBase(html: string, base: string): string {
  const m = html.match(/<head[^>]*>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + base + html.slice(at);
  }
  return base + html;
}
