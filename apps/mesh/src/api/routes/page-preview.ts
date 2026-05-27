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

type Variables = { meshContext: MeshContext };

function routeBaseUrl(reqUrl: string): string {
  const url = new URL(reqUrl);
  return `${url.protocol}//${url.host}`;
}

export function createPagePreviewRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  // The Studio-controlled host iframe. The preview pane loads this once
  // and drives transitions via postMessage; the host dynamically imports
  // the page's chunks from /files/... to render in place.
  app.get("/host", () => {
    return new Response(PAGE_PREVIEW_HOST_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
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
