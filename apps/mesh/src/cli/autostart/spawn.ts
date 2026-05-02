/**
 * Spawns the detected MCP project's dev server and waits for it to listen.
 *
 * The child's stdout/stderr is piped into the Ink TUI log store via the same
 * mechanism `serve.ts` uses for worker processes — so users see the project's
 * own logs without having to find a separate terminal.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { addLogEntry } from "../cli-store";
import { findAvailablePort } from "../find-available-port";
import type { DetectedProject } from "./detect";

const PM_RUN: Record<DetectedProject["packageManager"], string[]> = {
  bun: ["bun", "run"],
  pnpm: ["pnpm", "run"],
  yarn: ["yarn", "run"],
  npm: ["npm", "run"],
  deno: ["deno", "task"],
};

const PM_INSTALL: Record<DetectedProject["packageManager"], string[] | null> = {
  bun: ["bun", "install"],
  pnpm: ["pnpm", "install"],
  yarn: ["yarn", "install"],
  npm: ["npm", "install"],
  deno: null, // deno installs on first run
};

const HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 250;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes
// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function pipeChildOutput(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function flush(line: string) {
    const stripped = stripAnsi(line).trim();
    if (!stripped) return;
    addLogEntry({
      method: "",
      path: "",
      status: 0,
      duration: 0,
      timestamp: new Date(),
      rawLine: `${prefix} ${stripped}`,
    });
  }

  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) flush(l);
    }
    if (buffer) flush(buffer);
  })();
}

export interface SpawnedDevServer {
  port: number;
  baseUrl: string;
  mcpUrl: string;
  /** Subprocess handle so the orchestrator can register it for shutdown. */
  child: import("bun").Subprocess;
  /** Stop the child. Idempotent. */
  kill: () => void;
}

/**
 * Probe candidate URLs until one of them returns a non-network-error response.
 * MCP servers commonly respond 405/406 to GET (they want POST), which is fine —
 * we only care that the port is bound.
 */
async function waitForListen(
  candidates: string[],
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(2_000),
        });
        // Any HTTP response means the server is up.
        void res.body?.cancel();
        return url;
      } catch {
        // not yet
      }
    }
    await new Promise((r) => setTimeout(r, HEALTHCHECK_INTERVAL_MS));
  }
  return null;
}

async function ensureDepsInstalled(project: DetectedProject): Promise<void> {
  const installCmd = PM_INSTALL[project.packageManager];
  if (!installCmd) return;
  const nodeModules = join(project.root, "node_modules");
  if (existsSync(nodeModules)) return;

  addLogEntry({
    method: "",
    path: "",
    status: 0,
    duration: 0,
    timestamp: new Date(),
    rawLine: `[autostart] node_modules missing, running ${installCmd.join(" ")}…`,
  });

  const child = Bun.spawn(installCmd, {
    cwd: project.root,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const prefix = `[${project.name} install]`;
  if (child.stdout) pipeChildOutput(child.stdout, prefix);
  if (child.stderr) pipeChildOutput(child.stderr, prefix);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(
      `${installCmd.join(" ")} exited with code ${code} (see logs above)`,
    );
  }
}

export async function startMcpDevServer(
  project: DetectedProject,
  options?: { startPort?: number; abortSignal?: AbortSignal },
): Promise<SpawnedDevServer> {
  await ensureDepsInstalled(project);

  const startPort = options?.startPort ?? 3001;
  const port = await findAvailablePort(startPort);
  const pmCmd = PM_RUN[project.packageManager];
  const cmd = pmCmd[0]!;
  const baseArgs = pmCmd.slice(1);
  const args = [...baseArgs, project.starter];

  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };

  addLogEntry({
    method: "",
    path: "",
    status: 0,
    duration: 0,
    timestamp: new Date(),
    rawLine: `[autostart] $ ${cmd} ${args.join(" ")} (cwd=${project.root}, PORT=${port})`,
  });

  const child = Bun.spawn([cmd, ...args], {
    cwd: project.root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const prefix = `[${project.name}]`;
  if (child.stdout) pipeChildOutput(child.stdout, prefix);
  if (child.stderr) pipeChildOutput(child.stderr, prefix);

  const baseUrl = `http://localhost:${port}`;
  const candidates = [`${baseUrl}/mcp`, `${baseUrl}/api/mcp`, `${baseUrl}/`];

  const ctrl = new AbortController();
  if (options?.abortSignal) {
    options.abortSignal.addEventListener("abort", () => ctrl.abort(), {
      once: true,
    });
  }

  // Race healthcheck against the child exiting (broken project, missing deps).
  let exitedCode: number | null = null;
  const childExitPromise = child.exited.then((code) => {
    exitedCode = code;
    ctrl.abort();
    return code;
  });

  const ready = await Promise.race([
    waitForListen(candidates, ctrl.signal),
    childExitPromise.then(() => null as string | null),
  ]);

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  if (!ready) {
    kill();
    if (exitedCode !== null) {
      throw new Error(
        `${project.packageManager} run ${project.starter} exited with code ${exitedCode} before binding :${port} (see logs above)`,
      );
    }
    throw new Error(
      `${project.name} did not bind :${port} within ${HEALTHCHECK_TIMEOUT_MS / 1000}s`,
    );
  }

  // Pick the URL we actually got a response from as the canonical mcp URL,
  // unless it's just the root path — in that case keep /mcp as a guess.
  const mcpUrl = ready.endsWith("/") ? `${baseUrl}/mcp` : ready;

  return { port, baseUrl, mcpUrl, child, kill };
}
