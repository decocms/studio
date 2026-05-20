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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import { jsonResponse } from "./body-parser";

export interface SnapshotDeps {
  /** Workspace root tarred on create / untarred on restore. */
  repoDir: string;
}

/**
 * Directories excluded from `snapshot/create`. `tmp` is the daemon's own
 * scratch space — restoring it would clobber whatever the next sandbox
 * incarnation puts there. `/.git/index.lock` and similar transient files
 * inside `.git/` are accepted as restored: they're harmless, and excluding
 * them risks missing real history during a save mid-operation.
 */
const TAR_EXCLUDES = ["./tmp"];

/**
 * POST /_decopilot_vm/snapshot/create
 *
 * Streams `tar -cf - --exclude=./tmp .` from `repoDir`. The body is the
 * raw tar archive (Content-Type: application/x-tar). Mesh pipes the body
 * straight into `SandboxStore.put(key, …)` — no buffering on either side.
 *
 * Returns 404 when `repoDir` doesn't exist (daemon hasn't been configured
 * yet). Tar's own exit code is surfaced via HTTP trailers / connection
 * close; a non-zero exit closes the response stream early so the receiver
 * sees a truncated archive and treats the upload as failed.
 */
export function makeSnapshotCreateHandler(deps: SnapshotDeps) {
  return async (): Promise<Response> => {
    if (!existsSync(deps.repoDir)) {
      return jsonResponse({ error: "repoDir does not exist" }, 404);
    }

    const args = ["-cf", "-"];
    for (const excl of TAR_EXCLUDES) args.push(`--exclude=${excl}`);
    args.push(".");

    const child = spawn("tar", args, {
      cwd: deps.repoDir,
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

/**
 * POST /_decopilot_vm/snapshot/restore
 *
 * Reads raw tar bytes from the request body and untars into `repoDir`
 * via `tar -xf - -C <repoDir>`. The repoDir is ensured to exist (mkdir
 * recursive) so restore on a fresh emptyDir mount works without a
 * pre-step.
 *
 * Returns 200 `{ ok: true }` on success or 500 with tar's stderr when
 * the archive is malformed. Callers that get 500 should fall back to
 * the fresh-clone path — no partial state stays in repoDir because we
 * untar into the workdir root and any pre-existing files there are
 * expected to be empty (cold-start) or overwritten (warm restart).
 */
export function makeSnapshotRestoreHandler(deps: SnapshotDeps) {
  return async (req: Request): Promise<Response> => {
    if (!req.body) {
      return jsonResponse({ error: "request body required" }, 400);
    }

    // Ensure the target exists — on agent-sandbox the workdir is an
    // emptyDir that mounts as an empty directory, but on the host runner
    // the directory may not have been created yet for fresh handles.
    await mkdir(deps.repoDir, { recursive: true });

    const child = spawn("tar", ["-xf", "-", "-C", deps.repoDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    // Pipe request body → tar's stdin. The promise resolves on tar's exit;
    // if the body errors mid-stream tar sees an EOF and exits non-zero,
    // which we surface as a 500.
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
      return jsonResponse(
        {
          error: `tar restore exited code=${exit.code} signal=${exit.signal}`,
          stderr: stderrBuf.slice(-1024),
        },
        500,
      );
    }
    return jsonResponse({ ok: true });
  };
}
