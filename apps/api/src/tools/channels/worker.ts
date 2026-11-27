/**
 * Studio's way to each channel worker's own actions (pairing a number,
 * connecting a bot, sending a message), which stay on the workers where the
 * sessions live. Each worker's MCP (`<origin>/api/mcp`) accepts
 * CHANNELS_HUB_TOKEN as admin, so who may run what is decided by the tools
 * before this is called, and the worker is told who acts (`_viewer`).
 * Arguments and results carry message content: never log them.
 */
import { getSettings } from "@/settings";

/** Worker tools that send or change what was sent. */
const SEND_TOOLS: ReadonlySet<string> = new Set([
  "send_message",
  "update_message",
  "cancel_message",
  "list_outbox",
]);

export type ActionScope = "channels:send" | "connections:manage";

export const scopeOf = (tool: string): ActionScope =>
  SEND_TOOLS.has(tool) ? "channels:send" : "connections:manage";

/** The workers' MCP App views: screens for the hub, not actions. */
const isView = (tool: string) => tool.startsWith("open_");

/** Fields only Studio writes; whatever a caller sent in them is dropped. */
const STAMPED = ["_viewer", "_org", "_member", "_owner", "_access"];

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The caller's arguments, with only Studio saying who acts. */
export function forwardedArguments(
  args: Record<string, unknown>,
  viewer: string,
): Record<string, unknown> {
  const forward = { ...args };
  for (const key of STAMPED) delete forward[key];
  forward._viewer = viewer;
  return forward;
}

type RpcMessage = {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

const isRpcMessage = (v: unknown): v is RpcMessage =>
  typeof v === "object" &&
  v !== null &&
  ("result" in v || "error" in v) &&
  !Array.isArray(v);

/**
 * The JSON-RPC answer in a Streamable HTTP body: plain JSON, or SSE events
 * whose `data:` lines hold messages (notifications may come before it).
 */
export function rpcMessageOf(body: string): RpcMessage {
  const events = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean);
  for (const data of events.length ? events : [body]) {
    const msg: unknown = JSON.parse(data);
    if (isRpcMessage(msg)) return msg;
  }
  throw new Error("The channel worker sent no answer.");
}

/** A tool result's payload (structured, else its text as JSON or as text). */
export function payloadOf(result: Record<string, unknown>): unknown {
  const content = Array.isArray(result.content)
    ? (result.content as { type?: string; text?: string }[])
    : [];
  const text = content.find((c) => c.type === "text")?.text;
  if (result.isError) throw new Error(text ?? "The channel refused the call.");
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES)
    throw new Error("The channel worker's answer is too large.");
  if (!res.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      throw new Error("The channel worker's answer is too large.");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** One JSON-RPC call to `source`'s worker; the result, or throws. */
async function rpc(
  source: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const { channelsHubToken, channelsWorkerUrls } = getSettings();
  if (!channelsHubToken || !channelsWorkerUrls) {
    throw new Error("Channel actions aren't configured on this Studio.");
  }
  const origin = channelsWorkerUrls[source];
  if (!origin) throw new Error(`${source} has no worker configured.`);
  let text: string;
  let res: Response;
  try {
    res = await fetch(new URL("/api/mcp", origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelsHubToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readCapped(res);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${source} didn't answer in time.`);
    }
    throw error;
  }
  if (!res.ok)
    throw new Error(`${source}: ${res.status} ${text.slice(0, 200)}`);
  const msg = rpcMessageOf(text);
  if (msg.error) throw new Error(`${source}: ${msg.error.message}`);
  return msg.result ?? {};
}

/** A worker's actions (views left out), with the capability each needs. */
export async function listWorkerTools(source: string, timeoutMs?: number) {
  const result = await rpc(source, "tools/list", {}, timeoutMs);
  const tools = Array.isArray(result.tools)
    ? (result.tools as {
        name: string;
        description?: string;
        inputSchema?: unknown;
      }[])
    : [];
  return tools
    .filter((t) => typeof t.name === "string" && !isView(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? null,
      scope: scopeOf(t.name),
      input_schema: t.inputSchema ?? null,
    }));
}

/** Run `tool` on `source`'s worker as `viewer` (an email). */
export async function callWorkerTool(
  source: string,
  tool: string,
  args: Record<string, unknown>,
  viewer: string,
  timeoutMs?: number,
): Promise<unknown> {
  if (isView(tool)) throw new Error(`'${tool}' is a view, not an action.`);
  return payloadOf(
    await rpc(
      source,
      "tools/call",
      { name: tool, arguments: forwardedArguments(args, viewer) },
      timeoutMs,
    ),
  );
}
