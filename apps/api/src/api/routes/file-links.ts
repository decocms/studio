/**
 * Readable share links for org files: `/f/:org/:volume/:path` redirects to the
 * read proxy (`/api/:org/fs/:volume/read?path=…`), which decides access by the
 * file's share mode. The link keeps the path's `/` separators instead of the
 * proxy's `%2F`-encoded query.
 */

import { Hono } from "hono";

export function createFileLinkRoutes() {
  const app = new Hono();
  app.get("/:org/:volume/:path{.+}", (c) => {
    const { org, volume, path } = c.req.param();
    const query = new URLSearchParams({ path });
    return c.redirect(
      `/api/${encodeURIComponent(org)}/fs/${encodeURIComponent(volume)}/read?${query}`,
      302,
    );
  });
  return app;
}
