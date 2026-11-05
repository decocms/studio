/** The card ANALYTICS_INSTALL hands the Super Agent. */

const COLLECTOR = "https://analytics.decocdn.com";

export function buildInstruction(registration: {
  id: string;
  key: string | null;
  modules: string[];
}): string {
  const tag = registration.key
    ? `<script async src="${COLLECTOR}/_dq/a.js?k=${registration.key}"></script>`
    : `<script async src="/_dq/a.js"></script>`;
  // A same-origin tag is already covered by 'self'.
  const csp = registration.key
    ? `- If the site sets a Content-Security-Policy (a response header in server or edge code, a \`<meta http-equiv>\`, or hosting config such as \`_headers\`), add \`${COLLECTOR}/_dq/\` to both \`script-src\` and \`connect-src\`: the tag loads from there and posts its events back there. Without it browsers block the tag and nothing is counted.
`
    : "";
  const purchases = registration.modules.includes("deco")
    ? `- Purchases: if the site emits commerce events on \`window.DECO.events\` (deco storefronts do), stop here — the collector already maps them. Otherwise follow the next point.
`
    : "";

  return `Add Deco Analytics, our first-party analytics, to this site so its traffic and conversions reach the Monitor.

The site is already registered with the collector as \`${registration.id}\`. Load this tag in the <head> of every page:

\`\`\`html
${tag}
\`\`\`
${registration.key ? "" : "\nIt is same-origin on purpose: the collector serves `/_dq/*` on this site's own domain.\n"}
Rules:
- One tag, in the shared root document or layout so every route gets it — find where this repo already puts global <head> content and follow that.
- Keep it \`async\`. Nothing on the page may wait on it or read from it while rendering: if it fails to load, the site renders exactly the same.
- Don't add an analytics package or copy the runtime into the bundle; the tag loads it.
- Pageviews, client-side navigations, web vitals and errors are collected automatically. Don't add pageview calls.
- Leave every other analytics tag (Google Analytics, GTM, OneDollarStats, pixels) untouched.
${csp}${purchases}- Find where the order confirmation renders and call, once per order:
  \`window.__dq?.purchase({ value, currency, transactionId, itemIds })\`
  with \`transactionId\` set to the order id, so a reload of the page doesn't count the order twice. If checkout isn't rendered by this repo (it's hosted by the commerce platform), skip this and say so in the PR.
- Don't touch unrelated code.

In the PR body, say where the tag went and how to check it: on a deployed page, the Network tab shows \`a.js\` loading and a \`POST …/_dq/e\` answered 2xx after a navigation.${registration.key ? " Events from a host the site isn't registered for are dropped, so a preview domain may show the tag loading with nothing stored; check production after the merge." : ""}`;
}
