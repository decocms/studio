/**
 * In-memory stand-in for the hosted Deco CMS delivery bucket (R2), on one
 * port, for the hosted content-protocol specs:
 *
 *   /<bucket>/<key>             the S3 API Studio writes through (path style):
 *                               PUT, GET, HEAD, DELETE, and GET ?list-type=2
 *   GET /sites/<...>            the public custom domain sites read: the
 *                               object with its ETag and Cache-Control, and
 *                               304 on a matching If-None-Match
 *   GET /__admin/objects        every object, for assertions
 *   GET /health
 *
 * Signatures are not checked. Standalone process (no app imports).
 */

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const port = Number(process.env.DELIVERY_STUB_PORT ?? "4104");
const BUCKET = "delivery";

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType: string;
  cacheControl: string | null;
}

const objects = new Map<string, StoredObject>();

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Decodes an `aws-chunked` body (`<hex>;chunk-signature=…\r\n<data>\r\n…0\r\n`). */
function decodeAwsChunked(raw: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const lineEnd = raw.indexOf(0x0a, i);
    if (lineEnd < 0) break;
    const header = raw.subarray(i, lineEnd).toString("latin1").trim();
    const size = Number.parseInt(header.split(";")[0] ?? "0", 16);
    i = lineEnd + 1;
    if (!size) break;
    for (let j = 0; j < size; j++) out.push(raw[i + j]!);
    i += size + 2;
  }
  return Buffer.from(out);
}

function listXml(prefix: string, token: string | null): string {
  const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  const start = token ? Number(token) : 0;
  const page = keys.slice(start, start + 1000);
  const truncated = start + page.length < keys.length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
    truncated
      ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>`
      : ""
  }
${page
  .map(
    (key) =>
      `<Contents><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(objects.get(key)!.etag)}</ETag><Size>${objects.get(key)!.body.length}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`,
  )
  .join("\n")}
</ListBucketResult>`;
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: string | Buffer,
): void {
  res.writeHead(status, headers);
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function s3(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  url: URL,
): Promise<void> {
  if (!key) {
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      send(
        res,
        200,
        { "content-type": "application/xml" },
        listXml(
          url.searchParams.get("prefix") ?? "",
          url.searchParams.get("continuation-token"),
        ),
      );
      return;
    }
    send(res, 200, {});
    return;
  }
  if (req.method === "PUT") {
    let body = await readBody(req);
    if (
      String(req.headers["content-encoding"] ?? "").includes("aws-chunked") ||
      req.headers["x-amz-decoded-content-length"] !== undefined
    ) {
      body = decodeAwsChunked(body);
    }
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    objects.set(key, {
      body,
      etag,
      contentType: String(
        req.headers["content-type"] ?? "application/octet-stream",
      ),
      cacheControl:
        (req.headers["cache-control"] as string | undefined) ?? null,
    });
    send(res, 200, { ETag: etag });
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    send(res, 204, {});
    return;
  }
  const object = objects.get(key);
  if (!object) {
    send(
      res,
      404,
      { "content-type": "application/xml" },
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>`,
    );
    return;
  }
  send(
    res,
    200,
    {
      ETag: object.etag,
      "content-type": object.contentType,
      ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
    },
    req.method === "HEAD" ? undefined : object.body,
  );
}

function publicRead(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): void {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "ETag",
  };
  const object = objects.get(key);
  if (!object) {
    send(res, 404, cors, "Not Found");
    return;
  }
  const headers = {
    ...cors,
    ETag: object.etag,
    "content-type": object.contentType,
    ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
  };
  if (req.headers["if-none-match"] === object.etag) {
    send(res, 304, headers);
    return;
  }
  send(res, 200, headers, req.method === "HEAD" ? undefined : object.body);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  if (path === "/health") return send(res, 200, {}, "ok");
  if (path === "/__admin/objects") {
    const prefix = url.searchParams.get("prefix") ?? "";
    return send(
      res,
      200,
      { "content-type": "application/json" },
      JSON.stringify(
        Object.fromEntries(
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, o]) => [
              key,
              {
                text: o.body.toString("utf-8"),
                etag: o.etag,
                cacheControl: o.cacheControl,
              },
            ]),
        ),
      ),
    );
  }
  if (path === `/${BUCKET}` || path.startsWith(`/${BUCKET}/`)) {
    s3(req, res, path.slice(BUCKET.length + 2), url).catch((error) =>
      send(res, 500, {}, String(error)),
    );
    return;
  }
  if (path.startsWith("/sites/")) return publicRead(req, res, path.slice(1));
  send(res, 404, {}, "Not Found");
}).listen(port, () => {
  console.log(`[delivery-stub] listening on http://localhost:${port}`);
});
