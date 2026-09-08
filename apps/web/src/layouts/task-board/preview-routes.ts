/** `https://host/base` + `/path` — the preview's origin, the route's path. */
export function previewRouteUrl(previewUrl: string, route: string): string {
  return new URL(route, previewUrl).toString();
}
