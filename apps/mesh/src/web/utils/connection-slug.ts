import { slugify } from "./slugify";

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
