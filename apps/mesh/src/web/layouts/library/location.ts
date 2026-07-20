/**
 * Library browse-path grammar (the `?path=` search param).
 *
 * The Library projects the org filesystem as one tree: the first segment is
 * the volume, and the synthetic `public` namespace maps
 * `public/<set>/...` → readonly volume `public-<set>` (mirroring the
 * sandbox's `org/public/<set>` mounts).
 *
 *   ""                     → root (volumes listing)
 *   "uploads/docs"         → volume "uploads", dir "docs"
 *   "public"               → public sets listing
 *   "public/core/skills"   → volume "public-core", dir "skills"
 */

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
  };
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
 * (`apps/mesh/src/file-storage/mount/provisioning.ts`); the browse-path →
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
