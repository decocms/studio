import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDecopilotId } from "@decocms/shared/sdk";
import { z } from "zod";
import type { Session } from "../lib/session";
import {
  errorMessage,
  requireSession,
  type SessionOptions,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";

export interface SandboxOptions extends SessionOptions {
  subcommand?: string;
  /** Positionals after the subcommand: the chat id, then the message or command. */
  args: string[];
  org?: string;
  /** Agent for `new`. Defaults to the org's default agent, which has no repo. */
  agent?: string;
  /** `exec` timeout in seconds; the daemon caps it at 120. */
  timeout?: number;
  /** Injectable for tests. Defaults to process stdout/stderr. */
  write?: (stream: "stdout" | "stderr", text: string) => void;
}

const USAGE = `Usage:
  deco sandbox new --org <slug> [--agent <id>]
  deco sandbox chat <chat-id> "<message>" --org <slug>
  deco sandbox exec <chat-id> --org <slug> [--timeout <s>] -- <command>`;

const ThreadSchema = z.object({
  item: z
    .looseObject({ id: z.string(), virtual_mcp_id: z.string() })
    .nullable(),
});
const TargetSchema = z.object({ virtualMcpId: z.string(), branch: z.string() });
type Target = z.infer<typeof TargetSchema>;
const TargetCacheSchema = z.record(
  z.string(),
  TargetSchema.extend({ at: z.number() }),
);
/** A chat's sandbox branch only moves if its org or repo changes; bound how long a stale one is trusted. */
const TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const TARGET_CACHE_MAX = 100;
const BashResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  timedOut: z.boolean(),
});
const OrganizationsSchema = z.object({
  organizations: z.array(z.looseObject({ id: z.string(), slug: z.string() })),
});

/** A failed request, already reported to the user. */
class Reported extends Error {}

/**
 * `deco sandbox` — a sandbox is a chat's: `new` creates a coding chat and boots
 * its sandbox, `chat` talks to the agent running in it, `exec` runs a command
 * there. The chat id is the sandbox id, and the chat is the one Studio shows.
 */
export async function sandboxCommand(options: SandboxOptions): Promise<number> {
  const { subcommand, args, org } = options;
  const needsChat = subcommand === "chat" || subcommand === "exec";
  if (
    !subcommand ||
    !["new", "chat", "exec"].includes(subcommand) ||
    (needsChat && args.length < 2)
  ) {
    console.error(USAGE);
    return 1;
  }
  if (!org) {
    console.error(
      "Missing --org <slug>. The slug is the first path segment of the studio URL.",
    );
    return 1;
  }
  const session = await requireSession(options);
  if (!session) return 1;
  const write =
    options.write ??
    ((stream, text) =>
      (stream === "stdout" ? process.stdout : process.stderr).write(text));
  const api = new Api(session, org, options.fetch);

  try {
    if (subcommand === "new") return await newSandbox(api, options.agent);
    const [threadId, ...rest] = args as [string, ...string[]];
    if (subcommand === "chat") {
      return await chat(api, threadId, rest.join(" "), write);
    }
    return await exec(
      api,
      join(options.dataDir, "sandboxes.json"),
      threadId,
      toScript(rest),
      options.timeout,
      write,
    );
  } catch (err) {
    if (!(err instanceof Reported)) console.error(errorMessage(err));
    return 1;
  }
}

async function newSandbox(api: Api, agent: string | undefined) {
  const agentId = agent ?? getDecopilotId(await api.orgId());
  const created = z.object({ item: z.object({ id: z.string() }) }).parse(
    await api.tool("COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: agentId, runtime: "sandbox" },
    }),
  );
  const threadId = created.item.id;
  // The boot keeps going after this returns; the first exec waits for it.
  await api.tool("THREAD_SANDBOX_START", { threadId, wait: false });
  console.error(`Sandbox booting for chat ${threadId}.`);
  console.log(threadId);
  return 0;
}

async function chat(
  api: Api,
  threadId: string,
  text: string,
  write: NonNullable<SandboxOptions["write"]>,
) {
  const { item } = ThreadSchema.parse(
    await api.tool("COLLECTION_THREADS_GET", { id: threadId }),
  );
  if (!item) throw new Error(`Chat not found: ${threadId}`);

  // Open the tail before posting: an idle thread's tail delivers only new
  // chunks, so opening it after the POST could miss the start of the reply.
  const base = `/api/${encodeURIComponent(api.org)}/decopilot/threads/${encodeURIComponent(threadId)}`;
  const tail = await api.fetch(`${base}/stream`, {
    method: "GET",
    headers: new Headers({ accept: "text/event-stream" }),
  });
  if (!tail.ok) return api.report(tail);

  const posted = await api.fetch(`${base}/messages`, {
    method: "POST",
    body: {
      bytes: JSON.stringify({
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
        agent: { id: item.virtual_mcp_id },
      }),
      contentType: "application/json",
    },
  });
  if (!posted.ok) {
    await tail.body?.cancel();
    return api.report(posted);
  }
  if (tail.status === 204 || !tail.body) {
    console.error(
      "Sent. Live output is unavailable; read the reply in Studio.",
    );
    return 0;
  }
  return printReply(tail.body, write);
}

/**
 * Prints a run's UI message chunks until it finishes.
 * ponytail: stops at the first `finish`, so a run already in flight when the
 * tail opened ends the output early; track run ids if that shows up.
 */
export async function printReply(
  body: ReadableStream<Uint8Array>,
  write: NonNullable<SandboxOptions["write"]>,
): Promise<number> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      let chunk: {
        type?: unknown;
        delta?: unknown;
        toolName?: unknown;
        errorText?: unknown;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // keepalives and `[DONE]`
      }
      if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
        write("stdout", chunk.delta);
      } else if (chunk.type === "tool-input-available") {
        write("stderr", `\n[${String(chunk.toolName)}]\n`);
      } else if (chunk.type === "error") {
        write("stderr", `\n${String(chunk.errorText)}\n`);
        return 1;
      } else if (chunk.type === "abort") {
        write("stderr", "\n[cancelled]\n");
        return 1;
      } else if (chunk.type === "finish") {
        write("stdout", "\n");
        return 0;
      }
    }
  }
  write("stderr", "\nThe stream closed before the reply finished.\n");
  return 1;
}

async function exec(
  api: Api,
  cacheFile: string,
  threadId: string,
  command: string,
  timeoutSeconds: number | undefined,
  write: NonNullable<SandboxOptions["write"]>,
) {
  const key = `${new URL(api.session.target).host}/${api.org}/${threadId}`;
  const run = (target: Target) =>
    api.fetch(
      `/api/${encodeURIComponent(api.org)}/sandbox/${encodeURIComponent(
        target.virtualMcpId,
      )}/${encodeURIComponent(target.branch)}/bash?thread=${encodeURIComponent(threadId)}`,
      {
        method: "POST",
        body: {
          bytes: JSON.stringify({
            command,
            ...(timeoutSeconds ? { timeout: timeoutSeconds * 1000 } : {}),
          }),
          contentType: "application/json",
        },
      },
    );

  // A remembered address skips the start round trip. 404/410 mean no sandbox
  // answered, so the command never ran and starting one then retrying is safe.
  const cached = (await readTargets(cacheFile))[key];
  let res =
    cached && Date.now() - cached.at < TARGET_TTL_MS ? await run(cached) : null;
  if (res && (res.status === 404 || res.status === 410)) {
    await res.body?.cancel();
    res = null;
  }
  if (!res) {
    const target = TargetSchema.parse(
      await api.tool("THREAD_SANDBOX_START", { threadId }),
    );
    await rememberTarget(cacheFile, key, target);
    res = await run(target);
  }
  if (!res.ok) return api.report(res);
  const result = BashResultSchema.parse(await res.json());
  write("stdout", result.stdout);
  write("stderr", result.stderr);
  if (result.timedOut) {
    write("stderr", "Timed out. Pass --timeout <s> (at most 120).\n");
    return 124;
  }
  return result.exitCode;
}

async function readTargets(file: string) {
  try {
    return TargetCacheSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return {};
  }
}

async function rememberTarget(file: string, key: string, target: Target) {
  const all = await readTargets(file);
  delete all[key];
  all[key] = { ...target, at: Date.now() };
  const kept = Object.entries(all)
    .filter(([, t]) => Date.now() - t.at < TARGET_TTL_MS)
    .slice(-TARGET_CACHE_MAX);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(Object.fromEntries(kept)));
}

/**
 * One argument is a script, run as written (`-- 'cd app && ls'`); several are
 * argv, each quoted so the remote shell sees the same words this one did.
 */
export function toScript(argv: string[]): string {
  if (argv.length === 1) return argv[0] as string;
  return argv
    .map((arg) =>
      /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

class Api {
  constructor(
    readonly session: Session,
    readonly org: string,
    readonly fetchImpl?: typeof fetch,
  ) {}

  fetch(
    path: string,
    init: Omit<Parameters<typeof studioFetch>[2], "fetch">,
  ): Promise<Response> {
    return studioFetch(this.session, path, { ...init, fetch: this.fetchImpl });
  }

  async report(res: Response): Promise<never> {
    await writeResponse(res, this.session, async (chunk) => {
      process.stderr.write(chunk);
    });
    process.stderr.write("\n");
    throw new Reported();
  }

  async tool(name: string, args: unknown): Promise<unknown> {
    const res = await this.fetch(
      `/api/${encodeURIComponent(this.org)}/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: { bytes: JSON.stringify(args), contentType: "application/json" },
      },
    );
    if (!res.ok) return this.report(res);
    return res.json();
  }

  async orgId(): Promise<string> {
    const res = await this.fetch("/api/_me/organizations", { method: "GET" });
    if (!res.ok) return this.report(res);
    const { organizations } = OrganizationsSchema.parse(await res.json());
    const match = organizations.find((o) => o.slug === this.org);
    if (!match)
      throw new Error(`Not a member of an organization "${this.org}".`);
    return match.id;
  }
}
