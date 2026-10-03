/**
 * A stand-in for `deco serve`, the Blocks CLI's local content-protocol server:
 * the protocol's own handler over an in-memory storage, served over real HTTP
 * on 127.0.0.1 with a token, the way the CLI serves the working tree. It is
 * the edge of the system under test (a developer's machine), so a spec can
 * drive the site editor against it and assert what the "working tree" holds.
 *
 * Like `deco serve`, it answers CORS for the site editor's origin; the
 * protocol handler itself is transport-agnostic.
 */

import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createContentHandler } from "@decocms/shared/blocks-protocol/server";
import { createAssetHandler } from "@decocms/shared/blocks-protocol/server/assets";
import {
  createMemoryStorage,
  type MemoryStorage,
} from "@decocms/shared/blocks-protocol/storage/memory";

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers,
    body: hasBody
      ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>)
      : undefined,
    duplex: "half",
  } as RequestInit);
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

export interface DecoServeStub {
  /** The protocol endpoint, `http://127.0.0.1:<port>/rpc`. */
  endpoint: string;
  token: string;
  /** The "working tree": what the editor saved. */
  storage: MemoryStorage;
  /** Every request body the server received, in order. */
  requestBodies: string[];
  close: () => Promise<void>;
}

export async function startDecoServeStub(params: {
  /** The site editor's origin, allowed for browser requests. */
  allowOrigin: string;
  schema: object;
  files?: Record<string, string>;
  secretsPublicKey?: string;
  /** What `describe.preview` points at (the dev app, `deco serve --preview`). */
  previewUrl?: string;
}): Promise<DecoServeStub> {
  const token = randomBytes(16).toString("hex");
  const storage = createMemoryStorage({
    state: {
      schema: JSON.stringify(params.schema),
      files: params.files ?? {},
      secretsPublicKey: params.secretsPublicKey ?? null,
    },
    description: { kind: "working-tree", idempotency: null },
  });
  const rpc = createContentHandler(storage, {
    token,
    server: { name: "deco-serve-stub", version: "0" },
    preview: params.previewUrl ? { url: params.previewUrl } : null,
  });
  const assets = createAssetHandler(storage, { token });
  const requestBodies: string[] = [];
  const cors = {
    "access-control-allow-origin": params.allowOrigin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, PUT, OPTIONS",
    "access-control-allow-private-network": "true",
    vary: "origin",
  };

  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const request = toRequest(req, origin);
    const route = new URL(request.url).pathname.startsWith("/assets/")
      ? assets
      : rpc;
    void (async () => {
      requestBodies.push(await request.clone().text());
      const response = await route(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      await send(
        new Response(response.body, { status: response.status, headers }),
        res,
      );
    })().catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/rpc`,
    token,
    storage,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
