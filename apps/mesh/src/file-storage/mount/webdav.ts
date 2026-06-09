/**
 * A minimal WebDAV/1 server over an `OrgFsApi`, targeting exactly one client:
 * rclone's `webdav` backend (`--webdav-vendor other`, no locking). The daemon
 * serves this on localhost; `rclone serve nfs` reads it and re-serves it as NFS
 * for the OS to mount kext-free. So the surface is just what rclone needs:
 * OPTIONS, PROPFIND (Depth 0/1), GET/HEAD (+Range), PUT, DELETE, MKCOL, MOVE.
 *
 * The request pathname IS the in-volume fs path (one server per mounted volume).
 */

import { type OrgFsApi, OrgFsApiError, type OrgFsNode } from "./api";

const DAV_METHODS =
  "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, PROPPATCH";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** URL pathname (possibly encoded, with slashes) → normalized in-volume path. */
function pathFromUrl(req: Request): string {
  const raw = decodeURIComponent(new URL(req.url).pathname);
  return raw.replace(/^\/+/, "").replace(/\/+$/, "");
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** WebDAV href for a node: leading slash, per-segment encoded, trailing slash for dirs. */
function hrefFor(path: string, isDir: boolean): string {
  const segs = path === "" ? [] : path.split("/").map(encodeURIComponent);
  let h = `/${segs.join("/")}`;
  if (isDir && !h.endsWith("/")) h += "/";
  return h;
}

function propResponse(node: OrgFsNode): string {
  const isDir = node.kind === "dir";
  const lastmod = new Date(node.updatedAt || Date.now()).toUTCString();
  const name = basename(node.path);
  const typeAndLen = isDir
    ? "<D:resourcetype><D:collection/></D:resourcetype>"
    : `<D:resourcetype/><D:getcontentlength>${node.size}</D:getcontentlength>`;
  return (
    `<D:response><D:href>${xmlEscape(hrefFor(node.path, isDir))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(name)}</D:displayname>` +
    `<D:getlastmodified>${lastmod}</D:getlastmodified>` +
    typeAndLen +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function multistatus(bodies: string[]): Response {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${bodies.join("")}</D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { "content-type": 'application/xml; charset="utf-8"' },
  });
}

/** Parse a single `bytes=a-b` range against a known length. null = no/!satisfiable. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "") {
    // suffix: last N bytes
    const n = Number(b);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

function mapError(err: unknown): Response {
  if (err instanceof OrgFsApiError) {
    return new Response(err.message, { status: err.status });
  }
  return new Response(err instanceof Error ? err.message : "error", {
    status: 500,
  });
}

/**
 * Build a WebDAV request handler over the given filesystem. Stateless — rclone's
 * `--vfs-cache-mode full` provides the lazy fetch + write-back cache.
 */
export function createWebdavHandler(
  api: OrgFsApi,
): (req: Request) => Promise<Response> {
  // The volume root ("") is an implicit directory with no manifest entry, so
  // synthesize it; everything else comes from the backing fs.
  const statNode = (p: string): Promise<OrgFsNode | null> =>
    p === ""
      ? Promise.resolve({
          path: "",
          kind: "dir" as const,
          size: 0,
          updatedAt: new Date().toUTCString(),
        })
      : api.stat(p);

  return async (req) => {
    const path = pathFromUrl(req);
    const method = req.method.toUpperCase();

    try {
      switch (method) {
        case "OPTIONS":
          return new Response(null, {
            status: 200,
            headers: { DAV: "1", Allow: DAV_METHODS, "MS-Author-Via": "DAV" },
          });

        case "PROPFIND": {
          const node = await statNode(path);
          if (!node) return new Response("Not Found", { status: 404 });
          const depth = req.headers.get("depth") ?? "1";
          const out = [propResponse(node)];
          if (depth !== "0" && node.kind === "dir") {
            for (const child of await api.listDir(path)) {
              out.push(propResponse(child));
            }
          }
          return multistatus(out);
        }

        case "GET":
        case "HEAD": {
          const node = await statNode(path);
          if (!node) return new Response("Not Found", { status: 404 });
          if (node.kind === "dir")
            return new Response("Is a directory", { status: 405 });
          const lastmod = new Date(node.updatedAt || Date.now()).toUTCString();
          const baseHeaders: Record<string, string> = {
            "content-type": "application/octet-stream",
            "last-modified": lastmod,
            "accept-ranges": "bytes",
          };
          if (method === "HEAD") {
            return new Response(null, {
              status: 200,
              headers: { ...baseHeaders, "content-length": String(node.size) },
            });
          }
          const bytes = await api.read(path);
          const range = parseRange(req.headers.get("range"), bytes.length);
          if (range) {
            const slice = bytes.subarray(range.start, range.end + 1);
            return new Response(slice as BodyInit, {
              status: 206,
              headers: {
                ...baseHeaders,
                "content-length": String(slice.length),
                "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
              },
            });
          }
          return new Response(bytes as BodyInit, {
            status: 200,
            headers: { ...baseHeaders, "content-length": String(bytes.length) },
          });
        }

        case "PUT": {
          const body = new Uint8Array(await req.arrayBuffer());
          await api.write(
            path,
            body,
            req.headers.get("content-type") ?? undefined,
          );
          return new Response(null, { status: 201 });
        }

        case "DELETE": {
          await api.remove(path);
          return new Response(null, { status: 204 });
        }

        case "MKCOL": {
          await api.mkdir(path);
          return new Response(null, { status: 201 });
        }

        case "MOVE": {
          const dest = req.headers.get("destination");
          if (!dest)
            return new Response("Missing Destination", { status: 400 });
          // Destination may be an absolute URL or a path; take the pathname.
          let destPath: string;
          try {
            destPath = decodeURIComponent(new URL(dest).pathname);
          } catch {
            destPath = decodeURIComponent(dest);
          }
          destPath = destPath.replace(/^\/+/, "").replace(/\/+$/, "");
          await api.move(path, destPath);
          return new Response(null, { status: 201 });
        }

        // rclone may PROPPATCH mtimes; accept as a no-op so it doesn't error.
        case "PROPPATCH":
          return multistatus([
            `<D:response><D:href>${xmlEscape(hrefFor(path, false))}</D:href>` +
              `<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status>` +
              `</D:propstat></D:response>`,
          ]);

        default:
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: DAV_METHODS },
          });
      }
    } catch (err) {
      return mapError(err);
    }
  };
}
