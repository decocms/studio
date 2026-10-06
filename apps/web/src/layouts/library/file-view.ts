export type LibraryFileView = "all" | "documents" | "media";

const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "txt",
  "md",
  "markdown",
  "xls",
  "xlsx",
  "ods",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "odp",
  "key",
  "pages",
  "numbers",
  "html",
  "htm",
  "epub",
]);
const MEDIA_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "tif",
  "tiff",
  "ico",
  "heic",
  "heif",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
]);

export function matchesLibraryFileView(
  path: string,
  view: LibraryFileView,
): boolean {
  if (view === "all") return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return (view === "media" ? MEDIA_EXTENSIONS : DOCUMENT_EXTENSIONS).has(
    extension,
  );
}

export const LIBRARY_MODIFIED = ["any", "today", "week", "month"] as const;
export type LibraryModified = (typeof LIBRARY_MODIFIED)[number];

const MODIFIED_WINDOW_DAYS: Record<Exclude<LibraryModified, "any">, number> = {
  today: 1,
  week: 7,
  month: 30,
};

/** `today` is the last 24 hours, not the calendar day: a file from 11pm
 *  should not vanish at midnight. */
export function matchesLibraryModified(
  updatedAt: string,
  modified: LibraryModified,
  now: number = Date.now(),
): boolean {
  if (modified === "any") return true;
  const time = Date.parse(updatedAt);
  if (Number.isNaN(time)) return false;
  return now - time <= MODIFIED_WINDOW_DAYS[modified] * 24 * 60 * 60 * 1000;
}
