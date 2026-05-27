import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zip } from "fflate";
import type { MeshContext } from "@/core/mesh-context";
import {
  buildDesignSystemExportBundle,
  buildPageExportBundle,
  getPagePreviewStatus,
} from "@/page-preview/service";
import { PAGE_PREVIEW_HOST_HTML } from "@/page-preview/host-html";
import { getSettings } from "@/settings";

type Variables = { meshContext: MeshContext };

function routeBaseUrl(reqUrl: string): string {
  const url = new URL(reqUrl);
  return `${url.protocol}//${url.host}`;
}

/**
 * Stable hash of the current iframe source so the in-iframe dev poller
 * can detect an edit-save cycle and reload itself. bun --hot reloads
 * the host-html module on every save, so the export changes too —
 * which means the hash changes — which means dev clients reload.
 *
 * Cached on first read because `createHash` is non-trivial and the
 * host source doesn't change within a process lifetime (bun --hot
 * forks the process; new process = new cache).
 */
let cachedHostHash: string | null = null;
function getHostHash(): string {
  if (cachedHostHash != null) return cachedHostHash;
  const h = createHash("sha1");
  h.update(PAGE_PREVIEW_HOST_HTML);
  cachedHostHash = h.digest("hex").slice(0, 12);
  return cachedHostHash;
}

/**
 * Inject a tiny polling script into the iframe in dev mode so the user
 * sees host-html.ts edits without a manual refresh. Studio's tab.tsx
 * is the source of truth for what the iframe should display; on reload
 * the existing host:hello / host:set-page handshake re-dispatches
 * whatever intent was active. State recovers in <1s.
 *
 * Production gets the raw HTML — no poller, no extra requests.
 */
function injectDevAutoReload(html: string, orgSlug: string): string {
  if (getSettings().nodeEnv === "production") return html;
  const hash = getHostHash();
  const versionUrl = `/api/${encodeURIComponent(orgSlug)}/page-preview/host-version`;
  const snippet =
    `<script>(function(){var v=${JSON.stringify(hash)};` +
    `setInterval(function(){fetch(${JSON.stringify(versionUrl)})` +
    `.then(function(r){return r.text()}).then(function(t){` +
    `if(t&&t!==v){location.reload()}}).catch(function(){})},1500)})();</script>`;
  return html.replace("</head>", `${snippet}\n</head>`);
}

export function createPagePreviewRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  // The Studio-controlled host iframe. The preview pane loads this once
  // and drives transitions via postMessage; the host dynamically imports
  // the page's chunks from /files/... to render in place. In dev mode
  // we inject a tiny poller that reloads the iframe when host-html.ts
  // changes — Studio re-dispatches intent on reload so state recovers.
  app.get("/host", (c) => {
    const orgSlug = c.req.param("org") ?? "";
    const body = injectDevAutoReload(PAGE_PREVIEW_HOST_HTML, orgSlug);
    return new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // Sibling endpoint the dev-mode poller hits to detect changes.
  // Returns just the host-content hash; cheap, no auth, no I/O.
  app.get("/host-version", () => {
    return new Response(getHostHash(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  app.get("/state", async (c) => {
    const ctx = c.get("meshContext");
    const org = ctx.organization;
    if (!org?.id || !ctx.objectStorage) {
      throw new HTTPException(401, {
        message: "Organization context required",
      });
    }

    return c.json(
      await getPagePreviewStatus({
        orgId: org.id,
        objectStorage: ctx.objectStorage,
        orgSlug: org.slug ?? c.req.param("org"),
        baseUrl: routeBaseUrl(c.req.url),
      }),
    );
  });

  // NB: there is no /files/* route — page-preview assets are served via
  // Studio's canonical /api/{org}/files/{key} redirect on object storage.
  // Persistence and serving share the same key namespace (page-preview/...).

  app.get("/export", async (c) => {
    const ctx = c.get("meshContext");
    const org = ctx.organization;
    if (!org?.id || !ctx.objectStorage) {
      throw new HTTPException(401, {
        message: "Organization context required",
      });
    }

    const kind = c.req.query("kind");
    const slug = c.req.query("slug");
    if (kind !== "page" && kind !== "design-system") {
      throw new HTTPException(400, {
        message: "kind must be 'page' or 'design-system'",
      });
    }
    if (!slug) {
      throw new HTTPException(400, { message: "slug query param required" });
    }

    let bundle: Awaited<ReturnType<typeof buildPageExportBundle>>;
    try {
      const args = {
        orgId: org.id,
        objectStorage: ctx.objectStorage,
        slug,
      };
      bundle =
        kind === "page"
          ? await buildPageExportBundle(args)
          : await buildDesignSystemExportBundle(args);
    } catch (err) {
      throw new HTTPException(404, { message: (err as Error).message });
    }
    const { bundleName, files } = bundle;
    const zipInput: Record<string, Uint8Array> = {};
    for (const file of files) {
      zipInput[`${bundleName}/${file.relativePath}`] = file.data;
    }

    const archive = await new Promise<Uint8Array>((resolve, reject) => {
      zip(zipInput, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    return new Response(archive as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundleName}.zip"`,
        "Content-Length": archive.byteLength.toString(),
        "Cache-Control": "no-store",
      },
    });
  });

  return app;
}
