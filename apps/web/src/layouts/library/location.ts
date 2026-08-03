/**
 * Library browse-path grammar (the `?path=` search param).
 *
 * The Library projects the org filesystem as one tree rooted at the org's
 * `home` volume: the first segment is the volume, and the synthetic `public`
 * namespace maps `public/<set>/...` → readonly volume `public-<set>`
 * (mirroring the sandbox's `org/public/<set>` mounts).
 *
 *   "home"                 → the landing view (the org's home folder)
 *   "uploads/docs"         → volume "uploads", dir "docs"
 *   "public"               → public sets listing
 *   "public/core/skills"   → volume "public-core", dir "skills"
 *
 * `""` still parses (empty location) but is not reachable from the UI — the
 * page falls back to `HOME_MOUNT_PATH`.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";

export interface LibraryLocation {
  /** Raw path segments, as browsed (incl. the `public/<set>` prefix). */
  segments: string[];
  /** Resolved org-fs volume, or null at root / the public-sets listing. */
  volume: string | null;
  /** In-volume directory path ("" = volume root). */
  dirPath: string;
  isPublic: boolean;
  publicSet: string | null;
  readOnly: boolean;
  /** The Library's landing view: the root of the org's home volume. The
   *  system-folder cards and the "Recently added" feed live only here. */
  isHomeRoot: boolean;
}

export function parseLibraryPath(path: string): LibraryLocation {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const isPublic = segments[0] === "public";
  const publicSet = isPublic ? (segments[1] ?? null) : null;
  const volume = isPublic
    ? publicSet
      ? `public-${publicSet}`
      : null
    : (segments[0] ?? null);
  const dirPath = (isPublic ? segments.slice(2) : segments.slice(1)).join("/");
  return {
    segments,
    volume,
    dirPath,
    isPublic,
    publicSet,
    readOnly: isPublic,
    isHomeRoot: volume === HOME_MOUNT_PATH && dirPath === "",
  };
}

/** Display label for a browse-path segment. The `public` volume presents as
 *  "skills" — it holds the shared read-only skill sets — while the browse path
 *  and the sandbox mount stay `public/<set>`. Not translated: these are path
 *  identifiers, like `uploads`. */
export function segmentLabel(segment: string): string {
  return segment === "public" ? "skills" : segment;
}

/** Browse path for an in-volume entry path, from the current location. */
export function browsePathFor(
  location: LibraryLocation,
  entryPath: string,
): string {
  if (location.isPublic && location.publicSet) {
    return `public/${location.publicSet}/${entryPath}`;
  }
  return location.volume ? `${location.volume}/${entryPath}` : entryPath;
}

const PUBLIC_VOLUME_PREFIX = "public-";

/** Set name for a `public-<set>` volume (a shared read-only set), else null. */
export function publicSetOf(volume: string): string | null {
  return volume.startsWith(PUBLIC_VOLUME_PREFIX)
    ? volume.slice(PUBLIC_VOLUME_PREFIX.length)
    : null;
}

/** Browse path for a cross-volume feed entry (search/recent): `public-<set>`
 *  volumes map back to the `public/<set>` browse namespace. */
export function browsePathForEntry(volume: string, entryPath: string): string {
  const set = publicSetOf(volume);
  return set ? `public/${set}/${entryPath}` : `${volume}/${entryPath}`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Sandbox mount path for a Library browse path — where the agent's file tools
 * (`read`/`edit`/`grep`) actually reach the file: `org/home/…`,
 * `org/public/<set>/…`, etc.
 *
 * Client mirror of the server's `orgFsSandboxPath`
 * (`apps/api/src/file-storage/mount/provisioning.ts`); the browse-path →
 * mount mapping must stay in sync with the mount table there. Returns null for
 * the root / public-sets listing (no single file).
 */
export function orgFsMountPath(browsePath: string): string | null {
  const { volume, dirPath } = parseLibraryPath(browsePath);
  if (!volume) return null;
  let base: string;
  if (volume === "home") base = "org/home";
  else if (volume === "outputs") base = "org/.outputs";
  else if (volume === "uploads") base = "org/.uploads";
  else {
    const set = publicSetOf(volume);
    base = set ? `org/public/${set}` : `org/${volume}`;
  }
  return dirPath ? `${base}/${dirPath}` : base;
}
