/**
 * Minimal ustar reader for GitHub repo tarballs — just enough to pull file
 * entries out of `GET /repos/:o/:r/tarball/:ref` (gzipped tar with a single
 * top-level `<owner>-<repo>-<sha>/` directory). Handles the header shapes
 * GitHub emits: plain ustar name+prefix, pax extended headers (`x`) with a
 * `path` record, and GNU long names (`L`).
 */

import { gunzipSync } from "node:zlib";

export interface TarFile {
  /** Entry path with the tarball's top-level directory stripped. */
  path: string;
  content: Uint8Array;
}

const BLOCK = 512;

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const raw = readString(buf, offset, length).trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

/** Parse pax extended-header records (`<len> <key>=<value>\n`). */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const len = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1); // trailing \n dropped
    const eq = record.indexOf("=");
    if (eq !== -1) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

/** Extract regular files from a gzipped tarball, top-level dir stripped. */
export function extractTarGz(tgz: Uint8Array): TarFile[] {
  const tar = new Uint8Array(gunzipSync(tgz));
  const files: TarFile[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const nameField = readString(tar, offset, 100);
    if (nameField.length === 0) break; // two zero blocks end the archive
    const size = readOctal(tar, offset + 124, 12);
    const typeFlag = String.fromCharCode(tar[offset + 156] ?? 0);
    const prefix = readString(tar, offset + 345, 155);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === "x" || typeFlag === "g") {
      const records = paxRecords(tar.subarray(dataStart, dataEnd));
      if (typeFlag === "x") pendingPaxPath = records.get("path") ?? null;
      continue;
    }
    if (typeFlag === "L") {
      pendingLongName = readString(tar, dataStart, size);
      continue;
    }

    const rawPath =
      pendingPaxPath ??
      pendingLongName ??
      (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = null;
    pendingPaxPath = null;

    // '0' and NUL are regular files; everything else (dirs, links) is skipped.
    if (typeFlag !== "0" && typeFlag !== "\0") continue;

    // Strip the tarball's single top-level directory.
    const slash = rawPath.indexOf("/");
    const path = slash === -1 ? rawPath : rawPath.slice(slash + 1);
    if (!path) continue;
    files.push({ path, content: tar.slice(dataStart, dataEnd) });
  }
  return files;
}
