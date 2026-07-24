/**
 * Convert a string to a URL-friendly slug
 * Removes special characters, converts to lowercase, and replaces spaces with hyphens
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\//g, "-") // Replace forward slashes with hyphens
    .replace(/[^a-z0-9\s_-]+/g, "") // Remove special characters except word chars, spaces, underscores, and hyphens
    .replace(/[\s_-]+/g, "-") // Replace spaces, underscores, and hyphens with single hyphen
    .replace(/^-+|-+$/g, ""); // Remove leading and trailing hyphens
}
