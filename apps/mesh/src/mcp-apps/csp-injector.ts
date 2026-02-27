export const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export interface CSPInjectorOptions {
  csp?: string;
  allowExternalConnections?: boolean;
  allowedHosts?: string[];
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

function buildCSPPolicy(options: CSPInjectorOptions): string {
  if (options.csp) return options.csp;

  if (!options.allowExternalConnections) return DEFAULT_CSP;

  const hosts = options.allowedHosts;
  const connectSrc = !hosts || hosts.length === 0 ? "*" : hosts.join(" ");

  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}
