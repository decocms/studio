/**
 * HTTP plumbing for the content handler: bounded body reads (gzip request
 * bodies included), gzip responses and bearer-token checks. Web-standard APIs
 * only (Request, Response, CompressionStream), so it runs on Node, Bun,
 * Workers and Deno.
 */
import { sha256Hex } from "../canonical";

/** The body was larger than allowed (after decompression). */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`the request body is over ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** The body claimed an encoding it doesn't have, or one we don't decode. */
export class BodyEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyEncodingError";
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads the request body as bytes, refusing more than `limit` bytes. A
 * `Content-Encoding: gzip` body is decompressed, and the limit applies to the
 * decompressed bytes too, so gzip can't bypass it.
 */
export async function readBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  const encoding = (request.headers.get("content-encoding") ?? "identity")
    .trim()
    .toLowerCase();
  if (
    encoding === "identity" &&
    Number.isFinite(declared) &&
    declared > limit
  ) {
    throw new BodyTooLargeError(limit);
  }
  if (!request.body) return new Uint8Array(0);
  if (encoding === "identity") return readLimited(request.body, limit);
  if (encoding !== "gzip")
    throw new BodyEncodingError(`unsupported Content-Encoding "${encoding}"`);
  const decompressed = request.body.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  try {
    return await readLimited(decompressed, limit);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    throw new BodyEncodingError("the gzip body is corrupt");
  }
}

/** True when the request's `Accept-Encoding` accepts gzip. */
function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding = "", ...params] = part.trim().toLowerCase().split(";");
    if (coding.trim() !== "gzip" && coding.trim() !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** Bodies smaller than this aren't worth compressing. */
const GZIP_THRESHOLD_BYTES = 1024;

/** A JSON response, gzip-compressed when the request accepts it. */
export function jsonResponse(
  request: Request,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const responseHeaders = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    vary: "Accept-Encoding",
    ...headers,
  });
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength < GZIP_THRESHOLD_BYTES || !acceptsGzip(request)) {
    return new Response(bytes, { status, headers: responseHeaders });
  }
  responseHeaders.set("content-encoding", "gzip");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(
      new CompressionStream("gzip") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
  return new Response(stream, { status, headers: responseHeaders });
}

/** True when the request's `Content-Type` is JSON (`application/json`, any parameters). */
export function isJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type");
  return (
    type !== null &&
    type.split(";")[0]!.trim().toLowerCase() === "application/json"
  );
}

/** The bearer token of the request, or `null` without one. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Compares two strings in time independent of where they differ. */
export async function timingSafeEqualStrings(
  a: string,
  b: string,
): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++)
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
