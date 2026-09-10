/** The preview's origin + the route's path. Any path on `previewUrl` is
 *  dropped — deploy previews are bare origins. */
export function previewRouteUrl(previewUrl: string, route: string): string {
  return new URL(route, previewUrl).toString();
}
