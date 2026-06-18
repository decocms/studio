export interface TunnelSubjects {
  readonly hostToken: string;
  readonly request: string;
  readonly body: string;
  readonly reply: string;
  readonly abort: string;
}

export interface ParsedTunnelUrl {
  readonly url: URL;
  readonly hostname: string;
  readonly pathWithSearch: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SUBJECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const encodeSubjectToken = (value: string): string => {
  if (value.trim().length === 0) {
    throw new TypeError("subject token value must not be empty");
  }

  return bytesToBase64Url(new TextEncoder().encode(value));
};

const base64UrlToBase64 = (value: string): string => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;

  return base64 + "=".repeat(paddingLength);
};

export const decodeSubjectToken = (value: string): string => {
  if (!SUBJECT_TOKEN_PATTERN.test(value)) {
    throw new TypeError(
      "invalid subject token: expected only A-Z, a-z, 0-9, '_' or '-'",
    );
  }

  const binary = atob(base64UrlToBase64(value));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

export const parseTunnelUrl = (
  input: string | URL | Request,
): ParsedTunnelUrl => {
  const url = new URL(input instanceof Request ? input.url : input);

  if (url.protocol !== "tunnel:") {
    throw new TypeError(`expected tunnel: URL, got ${url.protocol}`);
  }

  if (url.hostname.trim().length === 0) {
    throw new TypeError("tunnel URL hostname must not be empty");
  }

  return {
    url,
    hostname: url.hostname,
    pathWithSearch: `${url.pathname}${url.search}`,
  };
};

export const buildTunnelSubjects = (
  hostname: string,
  requestId: string,
): TunnelSubjects => {
  if (hostname.trim().length === 0) {
    throw new TypeError("hostname must not be empty");
  }

  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError(
      "invalid requestId: expected only A-Z, a-z, 0-9, '_' or '-'",
    );
  }

  const hostToken = encodeSubjectToken(hostname);
  const hostPrefix = `tunnel.v1.host.${hostToken}`;
  const requestPrefix = `${hostPrefix}.req.${requestId}`;

  return {
    hostToken,
    request: `${hostPrefix}.request`,
    body: `${requestPrefix}.body`,
    reply: `${requestPrefix}.reply`,
    abort: `${requestPrefix}.abort`,
  };
};
