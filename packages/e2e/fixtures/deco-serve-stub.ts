/**
 * A stand-in for `deco serve`, the Blocks CLI's local content-protocol server:
 * the protocol's own handler over its filesystem storage (both public in
 * `@decocms/blocks`), rooted at a temporary working tree and served over real
 * HTTP with no token, the way the CLI serves one, at a `localhost` endpoint. It is
 * the edge of the system under test (a developer's machine), so a spec can
 * drive the site editor against it and assert what the "working tree" holds.
 *
 * Like `deco serve`, it answers CORS for the site editor's origin; the
 * protocol handler itself is transport-agnostic. Like `deco serve` (which
 * refuses to start outside one), the working tree is a git repository whose
 * seeded files are committed: `HEAD` is the base `changes.*` compares with.
 * `outdated` plays an 8.1.x `deco serve` (protocol 1.0, no `changes.*`).
 * `changes.get` entries carry the file's modification time (`modifiedAt`,
 * the protocol's optional field) even where the installed package predates it.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { createFsStorage } from "@decocms/blocks/protocol/storage/fs";
import { blockFileName } from "@decocms/blocks/protocol";

const run = promisify(execFile);

/** Git with no user or system config, and a fixed identity. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
  return stdout;
}

/** The JSON-RPC calls of a request body, for matching answers by id. */
function callsOf(
  body: string,
): Array<{ id?: unknown; method?: string; params?: unknown }> {
  try {
    const parsed = JSON.parse(body) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      id?: unknown;
      method?: string;
      params?: unknown;
    }>;
  } catch {
    return [];
  }
}

/**
 * The handler's answer with each JSON-RPC answer passed through `fix`
 * (given the call it answers), sent back plain.
 */
async function rewriteAnswers(
  response: Response,
  body: string,
  fix: (
    one: Record<string, unknown>,
    call: { method?: string; params?: unknown } | undefined,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Response> {
  const methods = callsOf(body);
  // The handler gzips larger answers when the browser accepts it: read the
  // JSON through the encoding, then send it back plain.
  const gzipped = /gzip/i.test(response.headers.get("content-encoding") ?? "");
  const text =
    gzipped && response.body
      ? await new Response(
          response.body.pipeThrough(
            new DecompressionStream("gzip") as unknown as ReadableWritablePair<
              Uint8Array,
              Uint8Array
            >,
          ),
        ).text()
      : await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers });
  }
  const one = (a: unknown) => {
    const answerOne = a as Record<string, unknown>;
    return fix(
      answerOne,
      methods.find((m) => m.id === answerOne.id),
    );
  };
  const fixed = Array.isArray(answer)
    ? await Promise.all(answer.map(one))
    : await one(answer);
  return new Response(JSON.stringify(fixed), {
    status: response.status,
    headers,
  });
}

/**
 * An 8.1.x `deco serve`'s answers: `describe` says protocol 1.0, and the
 * methods 1.1 added are unknown to it.
 */
function asOutdated(response: Response, body: string): Promise<Response> {
  return rewriteAnswers(response, body, (one, call) => {
    if (call?.method?.startsWith("changes.")) {
      return {
        jsonrpc: "2.0",
        id: one.id,
        error: { code: -32601, message: `Method not found: ${call.method}` },
      };
    }
    const result = one.result as
      | { protocol?: string; version?: object }
      | undefined;
    if (result?.protocol) {
      return { ...one, result: { ...result, version: { major: 1, minor: 0 } } };
    }
    return one;
  });
}

/**
 * `changes.get` entries with the file's modification time (`modifiedAt`),
 * as a `deco serve` with the protocol's optional field answers. Fills it
 * only where the package's handler left it out, so it steps aside once the
 * installed `@decocms/blocks` reports it itself.
 */
function withModifiedAt(
  response: Response,
  body: string,
  blocksDir: string,
): Promise<Response> {
  return rewriteAnswers(response, body, async (one, call) => {
    const result = one.result as
      | { entries?: Record<string, Record<string, unknown>> }
      | undefined;
    if (call?.method !== "changes.get" || !result?.entries) return one;
    const entries: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(result.entries)) {
      if (entry.modifiedAt !== undefined || entry.after === null) {
        entries[name] = entry;
        continue;
      }
      const info = await stat(join(blocksDir, blockFileName(name))).catch(
        () => null,
      );
      entries[name] = info
        ? { ...entry, modifiedAt: info.mtime.toISOString() }
        : entry;
    }
    return { ...one, result: { ...result, entries } };
  });
}

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
  /** The protocol endpoint, `http://localhost:<port>/rpc`. */
  endpoint: string;
  /** The "working tree": the saved block files, by file name. */
  readFiles: () => Promise<Record<string, string>>;
  /** Every request body the server received, in order. */
  requestBodies: string[];
  /** Writes a saved block file behind the editor's back (another writer). */
  writeFile: (file: string, text: string) => Promise<void>;
  /** Runs git in the working tree (its `HEAD` is the changes' base). */
  git: (...args: string[]) => Promise<string>;
  close: () => Promise<void>;
}

export async function startDecoServeStub(params: {
  schema: object;
  files?: Record<string, string>;
  secretsPublicKey?: string;
  /** What `describe.preview` points at (the dev app, `deco serve --preview`). */
  previewUrl?: string;
  /** The port to listen on; any free one by default. */
  port?: number;
  /** Answers as an 8.1.x `deco serve` (protocol 1.0, no `changes.*`). */
  outdated?: boolean;
}): Promise<DecoServeStub> {
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
  // The seeded site is the last commit, as a cloned site is.
  await git(root, "init", "-q", "-b", "main");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "--no-verify", "-m", "site");
  const storage = createFsStorage({ root });
  const rpc = createContentHandler(storage, {
    server: { name: "deco-serve-stub", version: "0" },
    preview: params.previewUrl ? { url: params.previewUrl } : null,
  });
  const requestBodies: string[] = [];
  // Like deco serve: any Origin is answered, reflected.
  const corsFor = (req: IncomingMessage) => ({
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, PUT, OPTIONS",
    "access-control-allow-private-network": "true",
    vary: "origin",
  });

  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    const cors = corsFor(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const request = toRequest(req, origin);
    void (async () => {
      const body = await request.clone().text();
      requestBodies.push(body);
      const served = await rpc(request);
      const response = params.outdated
        ? await asOutdated(served, body)
        : body.includes('"changes.get"')
          ? await withModifiedAt(served, body, blocksDir)
          : served;
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
  await new Promise<void>((resolve) =>
    server.listen(params.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://localhost:${port}/rpc`,
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
    writeFile: (file, text) => writeFile(join(blocksDir, file), text),
    git: (...args) => git(root, ...args),
    close: async () => {
      // The editor polls over keep-alive connections; `close` alone waits
      // for them to go idle, which a polling page never does.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
