/**
 * Streams a volume's skill folders as one tar archive.
 *
 * Why this exists: the sandbox daemon used to materialize skills one file at a
 * time over the org-fs mount — a `stat`, a presign against this API, and an S3
 * GET each. For an org with ~120 skills that is ~350 round trips for ~1.3MB,
 * and it showed up as 40 of the 44 seconds before a run's first token. The bytes
 * were never the problem; the request count was. So the server, which already
 * knows the whole tree from one `org_fs_entry` query and reads S3 from inside
 * the datacenter, hands back the entire set in a single response.
 *
 * ustar, hand-rolled: the only consumer is our own daemon reading it with Go's
 * `archive/tar`, and a ~60-line writer beats a new runtime dependency for the
 * API. No gzip — 1.3MB over the cluster network is not what made this slow.
 */

import type { OrgFsEntry } from "../storage/org-fs";

/** Tar block size, and the header is exactly one block. */
const BLOCK = 512;

/** A skill directory to include, with the files that live under it. */
export interface SkillTarEntry {
  /** Path inside the archive (`<skill>/SKILL.md`). */
  name: string;
  size: number;
  /** Volume-relative path to read the bytes from. */
  sourcePath: string;
}

/**
 * The files belonging to skill folders at the volume root: every top-level dir
 * holding a `SKILL.md`, and everything beneath it. Mirrors the daemon's own
 * `detectSkills` so the two cannot disagree about what a skill is — a README or
 * a `.gitignore` sitting at the volume root is not one.
 */
export function selectSkillFiles(files: OrgFsEntry[]): SkillTarEntry[] {
  const skillDirs = new Set<string>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1) continue;
    if (f.path.slice(slash + 1) === "SKILL.md") {
      skillDirs.add(f.path.slice(0, slash));
    }
  }
  const out: SkillTarEntry[] = [];
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1 || !skillDirs.has(f.path.slice(0, slash))) continue;
    out.push({ name: f.path, size: f.size, sourcePath: f.path });
  }
  // Deterministic order: a byte-stable archive is cacheable and diffable, and
  // it makes the daemon's logs comparable between runs. Codepoint order, not
  // `localeCompare` — the archive must not depend on the server's locale.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * One 512-byte ustar header. Splits long paths across `prefix`/`name` (255 char
 * ceiling); a path that still does not fit is rejected by the caller rather
 * than silently truncated into a different file.
 */
export function tarHeader(name: string, size: number): Uint8Array | null {
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // Split at the FIRST separator that leaves a <=100 char base. Searching
    // backwards from there finds a slash too early in the path, leaving a base
    // still too long — which read as "cannot represent" for every nested file.
    const cut = name.indexOf("/", Math.max(0, name.length - 101));
    if (cut <= 0) return null;
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      return null;
    }
  }
  const h = Buffer.alloc(BLOCK);
  h.write(base, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "utf8"); // mode
  h.write(octal(0, 8), 108, 8, "utf8"); // uid
  h.write(octal(0, 8), 116, 8, "utf8"); // gid
  h.write(octal(size, 12), 124, 12, "utf8");
  h.write(octal(0, 12), 136, 12, "utf8"); // mtime: fixed, see below
  h.write("        ", 148, 8, "utf8"); // checksum placeholder (spaces)
  h.write("0", 156, 1, "utf8"); // typeflag: regular file
  h.write("ustar\0", 257, 6, "utf8");
  h.write("00", 263, 2, "utf8");
  h.write(prefix, 345, 155, "utf8");
  // Checksum is the sum of every byte with the field itself read as spaces —
  // which is why the placeholder above is written before this runs.
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 8), 148, 8, "utf8");
  return new Uint8Array(h);
}

/** Zero padding that rounds a file's bytes up to a whole block. */
function padding(size: number): Uint8Array {
  const rem = size % BLOCK;
  return new Uint8Array(rem === 0 ? 0 : BLOCK - rem);
}

/** How many objects are fetched at once. Reads are in-datacenter and tiny, so
 *  the win is overlap; batching keeps it to five lines instead of an ordered
 *  prefetch window. ponytail: batches, not a sliding window — revisit only if
 *  a set's tar is dominated by one slow object. */
const READ_BATCH = 8;

/**
 * Stream `entries` as a tar. `read` fetches one file's bytes. A file that fails
 * to read, or whose path will not fit ustar, is skipped — a partial archive of
 * good skills beats no skills — and `onSkip` reports it so the gap is visible
 * in logs rather than silent. Stops once `maxBytes` is reached.
 */
export function streamSkillTar(opts: {
  entries: SkillTarEntry[];
  read: (sourcePath: string) => Promise<Uint8Array>;
  maxBytes: number;
  onSkip?: (name: string, reason: string) => void;
}): ReadableStream<Uint8Array> {
  const { entries, read, maxBytes, onSkip } = opts;
  let sent = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (i < entries.length) {
        const batch = entries.slice(i, i + READ_BATCH);
        i += batch.length;
        const bytes = await Promise.all(
          batch.map((e) =>
            read(e.sourcePath).then(
              (b) => ({ e, b }),
              (err) => {
                onSkip?.(e.name, String(err));
                return null;
              },
            ),
          ),
        );
        let emitted = false;
        for (const got of bytes) {
          if (!got) continue;
          const header = tarHeader(got.e.name, got.b.byteLength);
          if (!header) {
            onSkip?.(got.e.name, "path too long for ustar");
            continue;
          }
          if (sent + got.b.byteLength > maxBytes) {
            onSkip?.(got.e.name, "archive size cap reached");
            controller.enqueue(new Uint8Array(BLOCK * 2));
            controller.close();
            return;
          }
          controller.enqueue(header);
          controller.enqueue(got.b);
          const pad = padding(got.b.byteLength);
          if (pad.byteLength > 0) controller.enqueue(pad);
          sent += got.b.byteLength;
          emitted = true;
        }
        // Every entry in the batch was skipped — loop for more rather than
        // returning, so a run of bad files cannot end the stream early.
        if (emitted) return;
      }
      // Two zero blocks terminate a tar.
      controller.enqueue(new Uint8Array(BLOCK * 2));
      controller.close();
    },
  });
}

/**
 * Wire-side ceiling on one volume's archive. Mirrors the daemon's on-disk
 * budget: a repo-sync volume is arbitrary user content, so neither end may
 * assume the other bounded it.
 */
export const SKILL_TAR_MAX_BYTES = 64 * 1024 * 1024;
