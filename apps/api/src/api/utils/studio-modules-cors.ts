/**
 * Studio's modules for a Blocks v8 site's page (apps/web/src/studio-modules)
 * are imported by the site's page, on the site's origin, from Studio's: the
 * built files under `/studio-modules/` answer with
 * `access-control-allow-origin: *` (public static code, read without
 * credentials). Every other file keeps no CORS header.
 */
const STUDIO_MODULES_PREFIX = "/studio-modules/";

export function withStudioModulesCors(
  request: Request,
  response: Response,
): Response {
  if (!new URL(request.url).pathname.startsWith(STUDIO_MODULES_PREFIX)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
