import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zip } from "fflate";
import type { MeshContext } from "@/core/mesh-context";
import {
  buildDesignSystemExportBundle,
  buildPageExportBundle,
  getPagePreviewStatus,
  resolvePagePreviewAsset,
} from "@/page-preview/service";
import { PAGE_PREVIEW_HOST_HTML } from "@/page-preview/host-html";

type Variables = { meshContext: MeshContext };

function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  return types[ext] ?? "application/octet-stream";
}

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
    if (!org?.id) {
      throw new HTTPException(401, {
        message: "Organization context required",
      });
    }

    return c.json(
      await getPagePreviewStatus({
        orgId: org.id,
        orgSlug: org.slug ?? c.req.param("org"),
        baseUrl: routeBaseUrl(c.req.url),
      }),
    );
  });

  app.get("/files/*", async (c) => {
    const ctx = c.get("meshContext");
    const org = ctx.organization;
    if (!org?.id) {
      throw new HTTPException(401, {
        message: "Organization context required",
      });
    }

    const prefix = `/api/${c.req.param("org") ?? ""}/page-preview/files/`;
    const rawPath = c.req.path.replace(prefix, "");
    let filePath: string;
    try {
      filePath = decodeURIComponent(rawPath);
    } catch {
      throw new HTTPException(400, { message: "Invalid file path" });
    }

    try {
      const resolved = await resolvePagePreviewAsset({
        orgId: org.id,
        path: filePath,
      });
      const file = Bun.file(resolved.absolutePath);
      return new Response(file.stream(), {
        headers: {
          "Content-Type": getContentType(resolved.absolutePath),
          "Content-Length": file.size.toString(),
          "Cache-Control": "no-store",
        },
      });
    } catch {
      throw new HTTPException(404, { message: "File not found" });
    }
  });

  app.get("/export", async (c) => {
    const ctx = c.get("meshContext");
    const org = ctx.organization;
    if (!org?.id) {
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
      bundle =
        kind === "page"
          ? await buildPageExportBundle({ orgId: org.id, slug })
          : await buildDesignSystemExportBundle({ orgId: org.id, slug });
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
