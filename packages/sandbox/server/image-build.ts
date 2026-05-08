import { spawn } from "node:child_process";
import { type Hash, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_IMAGE } from "../shared";
import { dockerExec, type DockerExecFn } from "./docker-cli";

export interface EnsureImageOptions {
  image?: string;
  /** Override docker inspect; falls through to a spawned `docker build` on miss. */
  exec?: DockerExecFn;
  /** Line-oriented progress sink for build stdout+stderr. */
  onLog?: (line: string) => void;
}

/** Directory containing the Dockerfile shipped with this package. */
const IMAGE_DIR = resolve(fileURLToPath(import.meta.url), "../../image");
/** Root of the sandbox package; used as docker build context. */
const SANDBOX_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DAEMON_BUNDLE = resolve(SANDBOX_ROOT, "daemon/dist/daemon.js");
const DOCKERFILE = resolve(IMAGE_DIR, "Dockerfile");
/** Static skills tree COPY'd into the image at /mnt/skills/public. */
const SKILLS_DIR = resolve(IMAGE_DIR, "skills");

/**
 * Label key embedding the content hash of (Dockerfile + daemon bundle) into
 * the built image. Mismatch with the on-disk hash signals a stale image.
 */
const IMAGE_HASH_LABEL = "mesh.daemon.hash";

let inflight: Promise<void> | null = null;

/**
 * Ensures the local sandbox image is present and current. Compares a hash of
 * the Dockerfile + daemon bundle against the `mesh.daemon.hash` label on the
 * existing image; rebuilds on mismatch (or when the image is missing) so that
 * dev edits to the daemon don't leave stale containers behind. Concurrent
 * callers await one shared build; a failed build clears the singleton so the
 * next call retries rather than resurfacing the stale error. No-op for
 * non-default images — those are assumed to be registry-hosted and pulled by
 * `docker run`.
 */
export function ensureSandboxImage(
  opts: EnsureImageOptions = {},
): Promise<void> {
  const image = opts.image ?? DEFAULT_IMAGE;
  if (image !== DEFAULT_IMAGE) return Promise.resolve();
  if (inflight) return inflight;

  const exec = opts.exec ?? dockerExec;
  const work = (async () => {
    const expected = await computeExpectedHash();
    const actual = await readImageHash(image, exec);
    if (actual === expected) return;
    opts.onLog?.(
      actual === null
        ? `building ${image}…`
        : `${image} stale (have ${actual}, want ${expected}); rebuilding…`,
    );
    await buildImage(image, expected, opts.onLog);
    opts.onLog?.(`${image} ready`);
  })();

  inflight = work.catch((err) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

async function computeExpectedHash(): Promise<string> {
  let daemon: Buffer;
  try {
    daemon = await readFile(DAEMON_BUNDLE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `sandbox daemon bundle missing at ${DAEMON_BUNDLE}. ` +
          `Run \`bun run --cwd=packages/sandbox build\` first.`,
      );
    }
    throw err;
  }
  const dockerfile = await readFile(DOCKERFILE);
  const hash = createHash("sha256").update(daemon).update(dockerfile);
  await hashDirectory(hash, SKILLS_DIR);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Fold a directory tree's contents into `hash` deterministically. Sorted by
 * entry name at each level; file paths and bytes both contribute, so renames
 * and content edits both bust the cache. Missing dir is treated as empty.
 */
async function hashDirectory(hash: Hash, dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      hash.update(`d:${entry.name}/`);
      await hashDirectory(hash, full);
    } else if (entry.isFile()) {
      hash.update(`f:${entry.name}:`);
      hash.update(await readFile(full));
    }
  }
}

async function readImageHash(
  image: string,
  exec: DockerExecFn,
): Promise<string | null> {
  const result = await exec([
    "image",
    "inspect",
    image,
    "--format",
    `{{index .Config.Labels "${IMAGE_HASH_LABEL}"}}`,
  ]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  // `docker inspect` prints "<no value>" when the label key is absent.
  return value && value !== "<no value>" ? value : null;
}

function buildImage(
  image: string,
  hash: string,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn(
      "docker",
      [
        "build",
        "-t",
        image,
        "--label",
        `${IMAGE_HASH_LABEL}=${hash}`,
        "-f",
        DOCKERFILE,
        SANDBOX_ROOT,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    streamLines(child.stdout, onLog);
    streamLines(child.stderr, onLog);
    child.on("error", (err) => {
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
      if (code === 0) resolveP();
      else
        reject(
          new Error(`docker build ${image} exited ${code ?? "(unknown)"}`),
        );
    });
  });
}

function streamLines(
  stream: NodeJS.ReadableStream | null,
  onLog?: (line: string) => void,
) {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLog?.(trimmed);
    }
  });
  stream.on("end", () => {
    const trimmed = buf.trim();
    if (trimmed) onLog?.(trimmed);
  });
}
