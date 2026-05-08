import { spawn } from "node:child_process";

export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Default workdir inside sandbox images; overridable via `EnsureOptions.workdir`. */
export const DEFAULT_WORKDIR = "/app";

export type DockerExecFn = (
  args: string[],
  timeoutMs?: number,
) => Promise<DockerResult>;

/**
 * On timeout, SIGKILL + append `[docker <sub>] timed out after <ms>ms` to
 * stderr. ENOENT at spawn is rewritten to an "install Docker" message.
 */
export function dockerExec(
  args: string[],
  timeoutMs?: number,
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer =
      timeoutMs != null
        ? setTimeout(() => {
            stderr += `\n[docker ${args[0]}] timed out after ${timeoutMs}ms`;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "docker CLI not found on PATH. Install Docker Desktop (macOS) or Docker Engine (Linux).",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export interface StartContainerOptions {
  /** Flags passed before the image; caller owns labels, mounts, ports, env, entrypoint. */
  args: readonly string[];
  command?: readonly string[];
  timeoutMs?: number;
  /** Short label used in error messages. */
  label: string;
  /** Override for test-mode `exec` injection from DockerSandboxRunner. */
  exec?: DockerExecFn;
}

/** `docker run -d <args> <image> [command...]` — returns container id. */
export async function startContainer(
  image: string,
  opts: StartContainerOptions,
): Promise<{ id: string }> {
  const run = opts.exec ?? dockerExec;
  const result = await run(
    ["run", "-d", ...opts.args, image, ...(opts.command ?? [])],
    opts.timeoutMs,
  );
  if (result.code !== 0) {
    const tail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(
      `docker run ${opts.label} failed (exit ${result.code}): ${tail}`,
    );
  }
  const id = result.stdout.trim().split("\n").pop()?.trim();
  if (!id) {
    throw new Error(`docker run ${opts.label} returned no container id`);
  }
  return { id };
}
