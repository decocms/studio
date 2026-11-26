/**
 * The engine's browser in a Studio sandbox. A host process (browser-host.ts)
 * keeps one Chromium and its pages inside the sandbox; every page call is one
 * JSON request to it, sent through the daemon's authenticated `/_sandbox/bash`
 * route and answered on stdout, or in a file read back through `/_sandbox/read`
 * when the answer is bigger than what the route keeps of stdout.
 *
 * The daemon exposes no authenticated route to an arbitrary port inside the
 * sandbox (its WebSocket proxy is the public preview's), so a remote
 * `chromium.connect` would need a port the preview could reach; this does not.
 */

import { createHash, randomUUID } from "node:crypto";
import { sleep as defaultSleep } from "@decocms/shared/std";
import { z } from "zod";
import { USER_AGENTS, VIEWPORTS } from "../browser.ts";
import {
  type BrowserPage,
  type BrowserPort,
  BrowserSessionError,
  type ScreenshotClip,
  type Viewport,
} from "../ports.ts";
import type { UxDevice } from "../types.ts";
import { HOST_DIR, HOST_SOCKET, hostProgram } from "./browser-host.ts";

/** One daemon call: POST `path` with a JSON body, as the daemon client sends it. */
export type DaemonCall = (path: string, body: unknown) => Promise<Response>;

const HOST_FILE = `${HOST_DIR}/host.js`;
const OUT_DIR = `${HOST_DIR}/out`;
const IN_DIR = `${HOST_DIR}/in`;
/** Where `npm install -g` put playwright-core in the sandbox image. */
const GLOBAL_MODULES = "/usr/local/lib/node_modules";
/** The daemon keeps the last 256 KiB of stdout; larger answers go through a file. */
const INLINE_OUTPUT_MAX = 200_000;
/** Base64 per bash command: one argv string tops out at 128 KiB on Linux. */
const COMMAND_CHUNK = 60_000;
/** The daemon kills a background task at 15 minutes; a host is replaced before that. */
const HOST_TASK_MS = 15 * 60_000;
const HOST_RECYCLE_MS = 12 * 60_000;
const HOST_IDLE_MS = 5 * 60_000;
const HOST_START_TIMEOUT_MS = 45_000;
/** The daemon's ceiling for a bash call that waits for its command. */
const BASH_CEILING_MS = 120_000;

/** curl exit codes: nothing listens on the socket (no host yet, or it died). */
const CURL_NOT_LISTENING = new Set([7]);

const bashResultSchema = z.object({
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  exitCode: z.number(),
  truncated: z.boolean().optional(),
});

const readResultSchema = z.object({
  kind: z.literal("text"),
  content: z.string(),
});

const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  }),
]);

const pageState = { url: z.string(), blocked: z.number().int().min(0) };
const pingSchema = z.object({
  instance: z.string(),
  startedAt: z.number(),
  ready: z.boolean(),
  error: z.string().nullable(),
  pages: z.number(),
});
const newPageSchema = z.object({ page: z.string().min(1), ...pageState });
const gotoSchema = z.object({
  status: z.number().int().nullable(),
  error: z.string().nullable(),
  ...pageState,
});
const stateSchema = z.object(pageState);
const evaluateSchema = z.object({ value: z.unknown(), ...pageState });
const screenshotSchema = z.object({ base64: z.string().min(1), ...pageState });
const clickSchema = z.object({
  navigation: z.string().nullable(),
  ...pageState,
});
const closeSchema = z.object({ blocked: z.number().int().min(0) });
const fetchSchema = z.object({
  status: z.number().int().min(100).max(599),
  url: z.string(),
  body: z.string(),
});

/** Nothing answers on the socket: the host has to be (re)started. */
class HostDown extends Error {}

/** The host answered `{ ok: false }`. */
class HostError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The daemon's numbered `/_sandbox/read` text, back to the file's own. */
function unnumbered(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}

export interface SandboxBrowserOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A BrowserPort whose pages live in the sandbox `daemon` reaches. */
export function sandboxBrowser(
  daemon: DaemonCall,
  options: SandboxBrowserOptions = {},
): BrowserPort {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  let host: Promise<z.infer<typeof pingSchema>> | null = null;
  /** Scripts the current host instance already holds, by id. */
  let known = new Set<string>();
  let hostInstance = "";
  const openPages = new Set<string>();

  const bash = async (
    command: string,
    timeoutMs: number,
    mode?: "background",
  ): Promise<z.infer<typeof bashResultSchema>> => {
    let res: Response;
    try {
      // Not the repo directory the route defaults to: this sandbox has no repo.
      res = await daemon("/_sandbox/bash", {
        command,
        cwd: "/tmp",
        timeout: timeoutMs,
        ...(mode ? { mode } : {}),
      });
    } catch (err) {
      throw new BrowserSessionError(
        `o sandbox do navegador não respondeu: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new BrowserSessionError(
        `o sandbox do navegador respondeu ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (mode === "background") return { stdout: "", stderr: "", exitCode: 0 };
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const parsed = bashResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new BrowserSessionError(
        "o sandbox do navegador respondeu fora do formato",
      );
    }
    return parsed.data;
  };

  const readFile = async (path: string): Promise<string> => {
    let res: Response;
    try {
      res = await daemon("/_sandbox/read", { path, full: true });
    } catch (err) {
      throw new BrowserSessionError(
        `o sandbox do navegador não respondeu: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const body = readResultSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !body.success) {
      throw new BrowserSessionError(
        `a resposta do navegador não pôde ser lida (${res.status})`,
      );
    }
    await bash(`rm -f -- ${quote(path)}`, 10_000).catch(() => {});
    return unnumbered(body.data.content);
  };

  /** One request to whatever host listens now; HostDown when none does. */
  const send = async (request: object, timeoutMs: number): Promise<unknown> => {
    const b64 = Buffer.from(JSON.stringify(request)).toString("base64");
    const id = randomUUID();
    const out = `${OUT_DIR}/${id}.json`;
    let feed = `printf %s ${quote(b64)} | base64 -d`;
    const inFile = `${IN_DIR}/${id}.b64`;
    if (b64.length > COMMAND_CHUNK) {
      for (let i = 0; i < b64.length; i += COMMAND_CHUNK) {
        const chunk = b64.slice(i, i + COMMAND_CHUNK);
        const r = await bash(
          `mkdir -p ${IN_DIR} && printf %s ${quote(chunk)} >> ${inFile}`,
          20_000,
        );
        if (r.exitCode !== 0) {
          throw new BrowserSessionError(
            `o pedido ao navegador não foi escrito: ${r.stderr.slice(0, 200)}`,
          );
        }
      }
      feed = `base64 -d ${inFile}`;
    }
    const seconds = Math.ceil(timeoutMs / 1000);
    const script = [
      "set -o pipefail",
      `mkdir -p ${OUT_DIR} || exit 3`,
      `${feed} | curl -sS --max-time ${seconds} --unix-socket ${HOST_SOCKET} -H 'content-type: application/json' --data-binary @- -o ${out} http://plan-browser/rpc`,
      "c=$?",
      `rm -f ${inFile}`,
      `if [ $c -ne 0 ]; then rm -f ${out}; echo "curl $c" >&2; exit 10; fi`,
      `n=$(wc -c < ${out})`,
      `if [ "$n" -le ${INLINE_OUTPUT_MAX} ]; then cat ${out}; rm -f ${out}; else printf '@file %s' ${out}; fi`,
    ].join("\n");
    const r = await bash(script, Math.min(BASH_CEILING_MS, timeoutMs + 15_000));
    if (r.exitCode === 10) {
      const curl = Number(r.stderr.match(/curl (\d+)/)?.[1]);
      if (CURL_NOT_LISTENING.has(curl)) throw new HostDown("no host");
      throw new BrowserSessionError(
        `o navegador do sandbox não respondeu (curl ${Number.isNaN(curl) ? "?" : curl})`,
      );
    }
    if (r.exitCode !== 0 || r.truncated) {
      throw new BrowserSessionError(
        `o pedido ao navegador falhou (${r.exitCode}): ${r.stderr.slice(0, 200)}`,
      );
    }
    const raw = r.stdout.startsWith("@file ")
      ? await readFile(r.stdout.slice("@file ".length).trim())
      : r.stdout;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new BrowserSessionError(
        "o navegador do sandbox respondeu algo que não é JSON",
      );
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new BrowserSessionError(
        "o navegador do sandbox respondeu fora do formato",
      );
    }
    if (!envelope.data.ok) {
      throw new HostError(envelope.data.error, envelope.data.code);
    }
    return envelope.data.result;
  };

  const ping = async () => {
    const parsed = pingSchema.safeParse(await send({ op: "ping" }, 5_000));
    if (!parsed.success) {
      throw new BrowserSessionError(
        "o navegador do sandbox respondeu fora do formato",
      );
    }
    return parsed.data;
  };

  const startHost = async () => {
    const program = Buffer.from(
      hostProgram({
        socket: HOST_SOCKET,
        modules: GLOBAL_MODULES,
        idleMs: HOST_IDLE_MS,
      }),
    ).toString("base64");
    const write = await bash(
      `mkdir -p ${HOST_DIR} && printf %s ${quote(program)} | base64 -d > ${HOST_FILE}`,
      20_000,
    );
    if (write.exitCode !== 0) {
      throw new BrowserSessionError(
        `o navegador não foi instalado no sandbox: ${write.stderr.slice(0, 200)}`,
      );
    }
    await bash(`exec node ${HOST_FILE}`, HOST_TASK_MS, "background");
    const deadline = now() + HOST_START_TIMEOUT_MS;
    for (;;) {
      try {
        const info = await ping();
        if (info.error) throw new BrowserSessionError(info.error);
        if (info.ready) return info;
      } catch (err) {
        if (!(err instanceof HostDown)) throw err;
      }
      if (now() > deadline) {
        throw new BrowserSessionError(
          `o navegador do sandbox não abriu em ${HOST_START_TIMEOUT_MS / 1000}s`,
        );
      }
      await sleep(500);
    }
  };

  /** The host as it is now: started when none answers, replaced when old and idle. */
  const connect = async () => {
    let info: z.infer<typeof pingSchema> | null = null;
    try {
      info = await ping();
    } catch (err) {
      if (!(err instanceof HostDown)) throw err;
    }
    if (info?.error) throw new BrowserSessionError(info.error);
    if (
      info &&
      info.ready &&
      now() - info.startedAt > HOST_RECYCLE_MS &&
      info.pages === 0
    ) {
      await send({ op: "shutdown" }, 5_000).catch(() => {});
      await sleep(300);
      info = null;
    }
    const ready = info?.ready ? info : await startHost();
    if (ready.instance !== hostInstance) {
      hostInstance = ready.instance;
      known = new Set();
    }
    return ready;
  };

  const ensureHost = () => {
    host ??= connect().catch((err: unknown) => {
      host = null;
      throw err;
    });
    return host;
  };

  /** A request to the host, (re)starting it once when nothing listens. */
  const call = async (request: object, timeoutMs: number): Promise<unknown> => {
    await ensureHost();
    try {
      return await send(request, timeoutMs);
    } catch (err) {
      if (!(err instanceof HostDown)) throw err;
      host = null;
      await ensureHost();
      return await send(request, timeoutMs);
    }
  };

  /** The result in `schema`'s shape, or the browser failing. */
  const parse = <T>(schema: z.ZodType<T>, value: unknown, op: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new BrowserSessionError(
        `o navegador respondeu ${op} fora do formato`,
      );
    }
    return parsed.data;
  };

  /** Page errors keep the browser's message; a page the host lost is the session failing. */
  const pageError = (err: unknown): unknown => {
    if (!(err instanceof HostError)) return err;
    if (err.code === "no_page") {
      return new BrowserSessionError(
        "a página fechou: o navegador do sandbox reiniciou",
      );
    }
    return new Error(err.message);
  };

  const pageCall = async (request: object, timeoutMs: number) => {
    try {
      return await call(request, timeoutMs);
    } catch (err) {
      throw pageError(err);
    }
  };

  const scriptId = (source: string) =>
    createHash("sha256").update(source).digest("hex").slice(0, 24);

  class SandboxPage implements BrowserPage {
    private lastUrl: string;
    private blocked: number;

    constructor(
      private readonly id: string,
      readonly viewport: Viewport,
      state: { url: string; blocked: number },
    ) {
      this.lastUrl = state.url;
      this.blocked = state.blocked;
    }

    private track<T extends { url: string; blocked: number }>(state: T): T {
      this.lastUrl = state.url;
      this.blocked = state.blocked;
      return state;
    }

    url() {
      return this.lastUrl;
    }

    blockedRequests() {
      return this.blocked;
    }

    async goto(url: string, timeoutMs: number) {
      const r = this.track(
        parse(
          gotoSchema,
          await pageCall(
            { op: "goto", page: this.id, url, timeoutMs },
            timeoutMs + 10_000,
          ),
          "goto",
        ),
      );
      return { status: r.status, error: r.error };
    }

    async reload(timeoutMs: number) {
      this.track(
        parse(
          stateSchema,
          await pageCall(
            { op: "reload", page: this.id, timeoutMs },
            timeoutMs + 10_000,
          ),
          "reload",
        ),
      );
    }

    async evaluate<A extends unknown[], R>(
      fn: (...args: A) => R,
      ...args: A
    ): Promise<Awaited<R>> {
      const source = fn.toString();
      const fnId = scriptId(source);
      const request = (withSource: boolean) => ({
        op: "evaluate",
        page: this.id,
        fn: fnId,
        args,
        ...(withSource ? { source } : {}),
      });
      let result: unknown;
      try {
        result = await call(request(!known.has(fnId)), 90_000).catch(
          (err: unknown) => {
            // The host restarted since it learned the script: send it again.
            if (err instanceof HostError && err.code === "unknown_fn") {
              return call(request(true), 90_000);
            }
            throw err;
          },
        );
      } catch (err) {
        throw pageError(err);
      }
      known.add(fnId);
      const r = this.track(parse(evaluateSchema, result, "evaluate"));
      // What the page returned, as puppeteer's evaluate hands it: JSON, typed by the script.
      return r.value as Awaited<R>;
    }

    async screenshot(opts: {
      quality: number;
      clip?: ScreenshotClip;
      captureBeyondViewport?: boolean;
    }) {
      const r = this.track(
        parse(
          screenshotSchema,
          await pageCall({ op: "screenshot", page: this.id, ...opts }, 60_000),
          "screenshot",
        ),
      );
      return new Uint8Array(Buffer.from(r.base64, "base64"));
    }

    async mouseMove(x: number, y: number, steps: number) {
      this.track(
        parse(
          stateSchema,
          await pageCall(
            { op: "mouseMove", page: this.id, x, y, steps },
            15_000,
          ),
          "mouseMove",
        ),
      );
    }

    async click(x: number, y: number, settleMs: number) {
      const r = this.track(
        parse(
          clickSchema,
          await pageCall(
            { op: "click", page: this.id, x, y, settleMs },
            settleMs + 30_000,
          ),
          "click",
        ),
      );
      return { navigation: r.navigation };
    }

    async close() {
      if (!openPages.delete(this.id)) return;
      const r = parse(
        closeSchema,
        await pageCall({ op: "close", page: this.id }, 15_000),
        "close",
      );
      this.blocked = r.blocked;
    }
  }

  return {
    async newPage(device: UxDevice, opts = {}) {
      const info = await ensureHost();
      // Replace an old host between pages, before the daemon's task ceiling kills it mid-page.
      if (openPages.size === 0 && now() - info.startedAt > HOST_RECYCLE_MS) {
        host = null;
      }
      const viewport = VIEWPORTS[device];
      const r = parse(
        newPageSchema,
        await pageCall(
          {
            op: "newPage",
            device: { ...viewport, userAgent: USER_AGENTS[device] },
            ...(opts.blockRequest
              ? { blockRequest: opts.blockRequest.toString() }
              : {}),
          },
          30_000,
        ),
        "newPage",
      );
      openPages.add(r.page);
      return new SandboxPage(
        r.page,
        {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
        },
        r,
      );
    },
    async fetch(url, opts) {
      try {
        return parse(
          fetchSchema,
          await call({ op: "fetch", url, ...opts }, opts.timeoutMs + 5_000),
          "fetch",
        );
      } catch (err) {
        if (err instanceof HostError) throw new TypeError(err.message);
        throw err;
      }
    },
  };
}
