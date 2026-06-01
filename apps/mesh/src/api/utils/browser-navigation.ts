// The authoritative signal for "a person navigated here in a browser" is the
// Fetch Metadata header `Sec-Fetch-Dest: document`, set by browsers ONLY for
// top-level navigations. It's a forbidden header — `fetch`/XHR cannot set or
// override it — so a browser's own subresource requests are correctly excluded:
// `<img>` sends `image`, `fetch`/XHR send `empty`, an iframe sends `iframe`.
// When the header is present we trust it exclusively.
//
// Clients that don't send Sec-Fetch-* (older browsers, some tools) fall back to
// content negotiation: real API clients send `application/json` or `*/*` (no
// `text/html` substring), so only an HTML-preferring navigation matches.
export const isBrowserNavigation = (c: {
  req: { header: (name: string) => string | undefined };
}) => {
  const dest = c.req.header("sec-fetch-dest");
  if (dest !== undefined) return dest === "document";
  // A client explicitly opting out with q=0 (e.g. `text/html;q=0`) must not
  // be treated as a browser navigation even though the substring matches.
  const accept = c.req.header("accept") ?? "";
  return (
    accept.includes("text/html") && !/text\/html\s*;\s*q\s*=\s*0/.test(accept)
  );
};
