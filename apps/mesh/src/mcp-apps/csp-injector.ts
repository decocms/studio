import type { McpUiResourceCsp } from "./types.ts";

export const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export interface CSPInjectorOptions {
  csp?: string;
  resourceCsp?: McpUiResourceCsp;
}

export function injectCSP(
  html: string,
  options: CSPInjectorOptions = {},
): string {
  const cspPolicy = buildCSPPolicy(options);
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${cspPolicy}">`;

  const headRegex = /<head(\s[^>]*)?>|<HEAD(\s[^>]*)?>/i;
  const headMatch = html.match(headRegex);

  if (headMatch) {
    const insertPos = (headMatch.index ?? 0) + headMatch[0].length;
    return html.slice(0, insertPos) + "\n" + metaTag + html.slice(insertPos);
  }

  const htmlTagRegex = /<html(\s[^>]*)?>|<HTML(\s[^>]*)?>/i;
  const htmlMatch = html.match(htmlTagRegex);

  if (htmlMatch) {
    const insertPos = (htmlMatch.index ?? 0) + htmlMatch[0].length;
    return (
      html.slice(0, insertPos) +
      "\n<head>\n" +
      metaTag +
      "\n</head>" +
      html.slice(insertPos)
    );
  }

  const doctypeRegex = /<!DOCTYPE[^>]*>/i;
  const doctypeMatch = html.match(doctypeRegex);

  if (doctypeMatch) {
    const insertPos = (doctypeMatch.index ?? 0) + doctypeMatch[0].length;
    return (
      html.slice(0, insertPos) +
      "\n<head>\n" +
      metaTag +
      "\n</head>" +
      html.slice(insertPos)
    );
  }

  return "<head>\n" + metaTag + "\n</head>\n" + html;
}

// Supports exact domains and wildcard subdomains (e.g. https://*.decocdn.com)
const DOMAIN_RE = /^https?:\/\/(\*\.)?[a-zA-Z0-9._-]+(:\d+)?\/?$/;

function validateDomains(domains: string[] | undefined): string[] {
  if (!domains || domains.length === 0) return [];
  return domains.filter((d) => DOMAIN_RE.test(d));
}

function buildCSPPolicy(options: CSPInjectorOptions): string {
  if (options.csp) return options.csp;

  const rc = options.resourceCsp;
  if (!rc) return DEFAULT_CSP;

  const resourceDomains = validateDomains(rc.resourceDomains);
  const connectDomains = validateDomains(rc.connectDomains);
  const frameDomains = validateDomains(rc.frameDomains);
  const baseUriDomains = validateDomains(rc.baseUriDomains);

  const hasResourceDomains = resourceDomains.length > 0;
  const hasConnectDomains = connectDomains.length > 0;
  const hasFrameDomains = frameDomains.length > 0;
  const hasBaseUriDomains = baseUriDomains.length > 0;

  if (
    !hasResourceDomains &&
    !hasConnectDomains &&
    !hasFrameDomains &&
    !hasBaseUriDomains
  ) {
    return DEFAULT_CSP;
  }

  const rd = resourceDomains.join(" ");

  const directives = [
    "default-src 'none'",
    hasResourceDomains
      ? `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${rd}`
      : "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
    hasResourceDomains
      ? `style-src 'unsafe-inline' ${rd}`
      : "style-src 'unsafe-inline'",
    hasResourceDomains
      ? `img-src * data: blob: ${rd}`
      : "img-src * data: blob:",
    hasResourceDomains
      ? `media-src * data: blob: ${rd}`
      : "media-src * data: blob:",
    hasResourceDomains ? `font-src data: ${rd}` : "font-src data:",
    hasConnectDomains
      ? `connect-src ${connectDomains.join(" ")}`
      : "connect-src 'none'",
    hasFrameDomains
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'",
    "worker-src blob:",
    "form-action 'none'",
    hasBaseUriDomains
      ? `base-uri ${baseUriDomains.join(" ")}`
      : "base-uri 'none'",
  ];

  return directives.join("; ");
}
