/**
 * A stand-in for `deco serve`, the Blocks CLI's local content-protocol server:
 * the protocol's own handler over its filesystem storage (both public in
 * `@decocms/blocks`), rooted at a temporary working tree and served over real
 * HTTP on 127.0.0.1 with a token, the way the CLI serves one. It is
 * the edge of the system under test (a developer's machine), so a spec can
 * drive the site editor against it and assert what the "working tree" holds.
 *
 * Like `deco serve`, it answers CORS for the site editor's origin; the
 * protocol handler itself is transport-agnostic.
 */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { createFsStorage } from "@decocms/blocks/protocol/storage/fs";

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
  /** The "working tree": the saved block files, by file name. */
  readFiles: () => Promise<Record<string, string>>;
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
  const root = await mkdtemp(join(tmpdir(), "deco-serve-stub-"));
  const blocksDir = join(root, ".deco", "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(
    join(root, ".deco", "schema.gen.json"),
    JSON.stringify(params.schema),
  );
  if (params.secretsPublicKey) {
    await writeFile(
      join(root, ".deco", "secrets.pub"),
      params.secretsPublicKey,
    );
  }
  for (const [file, text] of Object.entries(params.files ?? {})) {
    await writeFile(join(blocksDir, file), text);
  }
  const storage = createFsStorage({ root });
  const rpc = createContentHandler(storage, {
    token,
    server: { name: "deco-serve-stub", version: "0" },
    preview: params.previewUrl ? { url: params.previewUrl } : null,
  });
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
    void (async () => {
      requestBodies.push(await request.clone().text());
      const response = await rpc(request);
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
    readFiles: async () => {
      const files: Record<string, string> = {};
      for (const file of await readdir(blocksDir)) {
        if (file.endsWith(".json")) {
          files[file] = await readFile(join(blocksDir, file), "utf8");
        }
      }
      return files;
    },
    requestBodies,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
