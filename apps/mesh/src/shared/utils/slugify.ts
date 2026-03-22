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

export function getConnectionSlug(connection: {
  app_name?: string | null;
  connection_url?: string | null;
  title?: string;
  id?: string;
}): string {
  if (connection.app_name) {
    return slugify(connection.app_name);
  }
  if (connection.connection_url) {
    try {
      const parsed = new URL(connection.connection_url);
      const host = parsed.port
        ? `${parsed.hostname}-${parsed.port}`
        : parsed.hostname;
      const raw = (host + parsed.pathname).replace(/\/+$/, "");
      return slugify(raw);
    } catch {
      return slugify(connection.connection_url);
    }
  }
  if (connection.title) {
    return slugify(connection.title);
  }
  return connection.id ?? "unknown";
}
