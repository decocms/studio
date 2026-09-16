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
