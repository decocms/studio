/**
 * Snapshot routes — produce and consume plain `.tar` of the workspace.
 *
 *   POST /_decopilot_vm/snapshot/create   → streams tar bytes of repoDir
 *   POST /_decopilot_vm/snapshot/restore  → consumes tar bytes into repoDir
 *
 * Both spawn the system `tar(1)` directly so big archives never sit in
 * Node memory — stdout/stdin are piped through the HTTP body. No
 * compression: the workspace already contains compressed assets and the
 * dominant cost on a busy sandbox is CPU, not bytes on the wire. See
 * SANDBOX_PERSISTENCE.md for the broader rationale.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import { jsonResponse } from "./body-parser";

export interface SnapshotDeps {
  /** Workspace root tarred on create / untarred on restore. */
  workDir: string;
}

// tmp is daemon scratch space — restoring it would clobber the next incarnation's state.
const TAR_EXCLUDES = ["./tmp"];

export function makeSnapshotCreateHandler(deps: SnapshotDeps) {
  return async (): Promise<Response> => {
    if (!existsSync(deps.workDir)) {
      return jsonResponse({ error: "workDir does not exist" }, 404);
    }

    const args = ["-cf", "-"];
    for (const excl of TAR_EXCLUDES) args.push(`--exclude=${excl}`);
    args.push(".");

    const child = spawn("tar", args, {
      cwd: deps.workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stderr for diagnostics — tar writes file-not-found warnings
    // there even on success, but a real failure (exit != 0) is still
    // observable via the stream closing early.
    let stderrBuf = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    child.on("exit", (code, signal) => {
      if (code !== 0) {
        console.warn(
          `[snapshot] tar create exited code=${code} signal=${signal} stderr=${stderrBuf.slice(-512)}`,
        );
      }
    });

    const stream = Readable.toWeb(
      child.stdout,
    ) as unknown as ReadableStream<Uint8Array>;

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Access-Control-Allow-Origin": "*",
      },
    });
  };
}

export function makeSnapshotRestoreHandler(deps: SnapshotDeps) {
  return async (req: Request): Promise<Response> => {
    if (!req.body) {
      return jsonResponse({ error: "request body required" }, 400);
    }

    // Extract into a temp dir first; rename-swap on success so a failed or
    // truncated restore never leaves the workDir in a half-written state.
    const tmpDir = `${deps.workDir}.restore.${randomUUID().slice(0, 8)}`;
    await mkdir(tmpDir, { recursive: true });

    const child = spawn("tar", ["-xf", "-", "-C", tmpDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    const bodyStream = Readable.fromWeb(
      req.body as unknown as NodeWebReadableStream<Uint8Array>,
    );
    bodyStream.on("error", (err) => {
      console.warn(`[snapshot] restore body stream error: ${err.message}`);
      child.stdin.destroy(err);
    });
    bodyStream.pipe(child.stdin);

    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    if (exit.code !== 0) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return jsonResponse(
        {
          error: `tar restore exited code=${exit.code} signal=${exit.signal}`,
          stderr: stderrBuf.slice(-1024),
        },
        500,
      );
    }

    // Atomic swap: remove current workDir then rename the freshly-extracted temp.
    await rm(deps.workDir, { recursive: true, force: true });
    await rename(tmpDir, deps.workDir);

    return jsonResponse({ ok: true });
  };
}
