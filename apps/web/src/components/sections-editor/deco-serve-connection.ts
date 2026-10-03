/**
 * A connection to `deco serve`, the content-protocol server the Blocks CLI
 * runs on the editor's machine. The CLI prints a connect link,
 * `<studio>/connect#endpoint=<url>&token=<token>`; the token travels in the
 * fragment so it never reaches logs or `Referer` headers.
 */

import { z } from "zod";

const DecoServeConnectionSchema = z.object({
  /** The protocol endpoint, such as `http://127.0.0.1:4545/rpc`. */
  endpoint: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }),
  token: z.string().min(1).max(1024),
});

export type DecoServeConnection = z.infer<typeof DecoServeConnectionSchema>;

/** Reads a connect link's fragment; `null` when it isn't a valid one. */
export function parseConnectFragment(hash: string): DecoServeConnection | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const parsed = DecoServeConnectionSchema.safeParse({
    endpoint: params.get("endpoint") ?? "",
    token: params.get("token") ?? "",
  });
  return parsed.success ? parsed.data : null;
}

/** A stored connection, or `null` for anything else in storage. */
export function parseStoredConnection(
  value: unknown,
): DecoServeConnection | null {
  const parsed = DecoServeConnectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const PENDING_KEY = "studio:deco-serve-pending";

/**
 * Holds a connect link's connection for this tab until a project is picked,
 * so it survives the login redirect (which keeps no URL fragment).
 */
export function stashPendingConnection(connection: DecoServeConnection): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(connection));
  } catch {
    // Storage blocked: the flow then asks for the link again.
  }
}

export function readPendingConnection(): DecoServeConnection | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? parseStoredConnection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearPendingConnection(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}
