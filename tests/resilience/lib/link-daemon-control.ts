/**
 * Host-side controls for the resilience link-daemon scenarios:
 *   - start/stop the `link-daemon` container with the test user's API key,
 *   - poll `GET /api/links/me` for the link claim,
 *   - create an agent (virtual MCP) + ensure a sandbox (SANDBOX_START),
 *   - drive the org-scoped sandbox proxy routes (write/read/exec/config),
 *   - read the `/events` SSE and parse its log-replay frames.
 */
import { mcpCall } from "./studio-client";
import { pollUntil } from "./poll-until";

const STUDIO_URL = "http://127.0.0.1:13000";

/** Parse a string as JSON, returning undefined on failure (never throws). */
function tryParseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

export interface LinkClaim {
  machineId: string;
  hostname?: string;
  cliVersion: string;
  previewPort: number;
  connectedAt: number;
}

/** Run `docker compose -f <file> <args>`, optionally with extra env. */
async function composeExec(
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} exited ${code}: ${stderr || stdout}`,
    );
  }
  return stdout;
}

/** Start the profiled link-daemon container, injecting the API key. */
export async function startLinkDaemonContainer(apiKey: string): Promise<void> {
  await composeExec(
    ["--profile", "link", "up", "-d", "--no-build", "link-daemon"],
    { DAEMON_API_KEY: apiKey },
  );
}

/** Stop + remove the link-daemon container (best effort). */
export async function stopLinkDaemonContainer(): Promise<void> {
  try {
    await composeExec(["--profile", "link", "rm", "-sf", "link-daemon"]);
  } catch {
    /* best effort */
  }
}

/** GET /api/links/me with the session cookie; returns the claim or null. */
export async function getLinkClaim(cookie: string): Promise<LinkClaim | null> {
  const res = await fetch(`${STUDIO_URL}/api/links/me`, {
    headers: { cookie },
  });
  if (res.status !== 200) return null;
  const body = (await res.json()) as LinkClaim | null;
  return body;
}

/** Poll until a claim exists; returns it. */
export async function waitForLinkClaim(
  cookie: string,
  timeoutMs = 60_000,
): Promise<LinkClaim> {
  let claim: LinkClaim | null = null;
  await pollUntil(
    async () => {
      claim = await getLinkClaim(cookie);
      return claim != null;
    },
    { timeoutMs, intervalMs: 1_000, label: "wait-for-link-claim" },
  );
  // pollUntil throws if not met, so claim is non-null here.
  return claim as unknown as LinkClaim;
}

/** Create an agent (virtual MCP); returns its id. */
export async function createAgent(
  orgId: string,
  cookie: string,
  title: string,
): Promise<string> {
  const { result } = await mcpCall(
    `${orgId}_self`,
    "tools/call",
    {
      name: "COLLECTION_VIRTUAL_MCP_CREATE",
      arguments: { data: { title, connections: [] } },
    },
    { cookie },
  );
  const data = tryParseJson(result?.content?.[0]?.text) ?? result;
  const id = data?.item?.id ?? data?.id;
  if (!id) {
    throw new Error(`createAgent: no id in result: ${JSON.stringify(result)}`);
  }
  return id as string;
}

export interface SandboxStartResult {
  sandboxHandle: string;
  previewUrl?: string;
  branch: string;
  sandboxProviderKind: string;
}

/** Ensure a user-desktop sandbox for the agent; returns the handle. */
export async function sandboxStart(
  orgId: string,
  cookie: string,
  virtualMcpId: string,
  branch: string,
): Promise<SandboxStartResult> {
  const { result } = await mcpCall(
    `${orgId}_self`,
    "tools/call",
    {
      name: "SANDBOX_START",
      arguments: {
        virtualMcpId,
        branch,
        sandboxProviderKind: "user-desktop",
      },
    },
    { cookie },
    { timeoutMs: 60_000 },
  );
  const data =
    result?.structuredContent ??
    tryParseJson(result?.content?.[0]?.text) ??
    result;
  if (!data?.sandboxHandle) {
    throw new Error(
      `sandboxStart: no sandboxHandle in result: ${JSON.stringify(result)}`,
    );
  }
  return data as SandboxStartResult;
}

/** Look up the org slug for the org-scoped sandbox routes. */
export async function getOrgSlug(
  orgId: string,
  cookie: string,
): Promise<string> {
  const { result } = await mcpCall(
    `${orgId}_self`,
    "tools/call",
    { name: "ORGANIZATION_GET", arguments: {} },
    { cookie },
  );
  const data =
    result?.structuredContent ??
    tryParseJson(result?.content?.[0]?.text) ??
    result;
  const slug = data?.slug ?? data?.organization?.slug ?? data?.item?.slug;
  if (!slug) {
    throw new Error(`getOrgSlug: no slug in result: ${JSON.stringify(result)}`);
  }
  return slug as string;
}

function sandboxBase(orgSlug: string, vmId: string, branch: string): string {
  return `${STUDIO_URL}/api/${orgSlug}/sandbox/${vmId}/${encodeURIComponent(
    branch,
  )}`;
}

/** POST a sandbox proxy sub-route as JSON; returns the Response. */
export async function sandboxPost(
  orgSlug: string,
  vmId: string,
  branch: string,
  subPath: string,
  cookie: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${sandboxBase(orgSlug, vmId, branch)}${subPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/** PUT the sandbox config. */
export async function sandboxPutConfig(
  orgSlug: string,
  vmId: string,
  branch: string,
  cookie: string,
  config: unknown,
): Promise<Response> {
  return fetch(`${sandboxBase(orgSlug, vmId, branch)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(config),
  });
}

/** Open the `/events` SSE and read up to `maxMs`, returning the raw text. */
export async function readEventsSnapshot(
  orgSlug: string,
  vmId: string,
  branch: string,
  cookie: string,
  maxMs = 4_000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  try {
    const res = await fetch(`${sandboxBase(orgSlug, vmId, branch)}/events`, {
      headers: { accept: "text/event-stream", cookie },
      signal: ctrl.signal,
    });
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      /* aborted by timer — return what we collected */
    }
    return text;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export interface SseLogFrame {
  source: string;
  data: string;
}

/** Parse `event: log\ndata: {source,data}\n\n` frames out of an SSE byte stream. */
export function parseSseLogFrames(raw: string): SseLogFrame[] {
  const frames: SseLogFrame[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    const isLog = lines.some(
      (l) => l.trim().replace(/^event:\s*/, "") === "log",
    );
    if (!isLog) continue;
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice("data: ".length)) as {
        source?: unknown;
        data?: unknown;
      };
      if (
        typeof parsed.source === "string" &&
        typeof parsed.data === "string"
      ) {
        frames.push({ source: parsed.source, data: parsed.data });
      }
    } catch {
      /* malformed data line — skip */
    }
  }
  return frames;
}
