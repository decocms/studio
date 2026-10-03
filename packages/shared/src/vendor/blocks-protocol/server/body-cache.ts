/**
 * A bounded cache of parsed entry bodies, keyed by file and version.
 *
 * Versions identify content, so a polling client that sees a new revision
 * only costs a read and a parse for the files that actually changed.
 */

export type ParsedBody =
  | { ok: true; value: Record<string, unknown>; bytes: number }
  | {
      ok: false;
      kind: "invalid-json" | "not-an-object" | "too-large";
      message: string;
      bytes: number;
    };

export class BodyCache {
  private readonly entries = new Map<string, ParsedBody>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  private static key(file: string, version: string) {
    return `${file}\0${version}`;
  }

  get(file: string, version: string): ParsedBody | undefined {
    const key = BodyCache.key(file, version);
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(file: string, version: string, body: ParsedBody): void {
    if (body.bytes > this.maxBytes) return;
    const key = BodyCache.key(file, version);
    const previous = this.entries.get(key);
    if (previous) {
      this.total -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, body);
    this.total += body.bytes;
    for (const [oldest, value] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.total -= value.bytes;
    }
  }
}

const utf8 = new TextEncoder();

/** Parses one stored entry, enforcing the per-entry byte limit. */
export function parseBody(text: string, maxBlockBytes: number): ParsedBody {
  const bytes = utf8.encode(text).byteLength;
  if (bytes > maxBlockBytes) {
    return {
      ok: false,
      kind: "too-large",
      bytes,
      message: `the file is over ${maxBlockBytes} bytes`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      kind: "invalid-json",
      bytes,
      message: (error as Error).message,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      kind: "not-an-object",
      bytes,
      message: "the file doesn't hold a JSON object",
    };
  }
  return { ok: true, value: value as Record<string, unknown>, bytes };
}
