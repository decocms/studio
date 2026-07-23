/**
 * WAF bypass header for deco-owned hosts.
 *
 * The browser tools (take_screenshot / scrape_url / inspect_page) run on
 * Browserless — headless Chrome from datacenter egress — which Cloudflare
 * bot management on deco's own zones scores as a bot and blocks. That breaks
 * agent QA/verification of deco previews (envs-*.decocdn.com) and
 * storefronts. Both zones carry a shared-secret skip rule matching the
 * `x-deco-probe-bypass` header; sending it gives Studio's tooling trusted
 * passage without loosening bot protection for anyone else.
 *
 * SECURITY: the header is attached ONLY when the target host is a deco zone
 * (*.decocdn.com / *.deco.site). Browser tools can target arbitrary URLs —
 * sending the secret to third-party origins would leak it.
 */
export function wafBypassHeaders(targetUrl: string): Record<string, string> {
  const token =
    typeof process !== "undefined"
      ? process.env?.DECO_WAF_BYPASS_TOKEN
      : undefined;
  if (!token) return {};
  try {
    const host = new URL(targetUrl).hostname;
    const decoHost =
      host === "decocdn.com" ||
      host === "deco.site" ||
      host.endsWith(".decocdn.com") ||
      host.endsWith(".deco.site");
    if (decoHost) return { "x-deco-probe-bypass": token };
  } catch {
    // Malformed URL — the Browserless call will fail on its own terms.
  }
  return {};
}
