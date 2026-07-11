/**
 * Typed SANDBOX_START failure codes carried over MCP's text-only error
 * channel. A thrown tool error only survives to the client as
 * `content[0].text`, so the code is prefixed onto the message and parsed
 * back on the frontend. Leaf module (no server deps) — safe to import from
 * both the tool handler and the web bundle.
 */

export const SANDBOX_START_ERROR_CODES = {
  /** No usable GitHub token for the connected repo — needs (re)auth. */
  githubNotAuthenticated: "GITHUB_NOT_AUTHENTICATED",
} as const;

export type SandboxStartErrorCode =
  (typeof SANDBOX_START_ERROR_CODES)[keyof typeof SANDBOX_START_ERROR_CODES];

const MARKER = "::";

export function encodeSandboxStartError(
  code: SandboxStartErrorCode,
  message: string,
): string {
  return `${code}${MARKER}${message}`;
}

export function decodeSandboxStartError(text: string): {
  code: SandboxStartErrorCode | null;
  message: string;
} {
  const i = text.indexOf(MARKER);
  if (i > 0) {
    const code = text.slice(0, i);
    if ((Object.values(SANDBOX_START_ERROR_CODES) as string[]).includes(code)) {
      return {
        code: code as SandboxStartErrorCode,
        message: text.slice(i + MARKER.length),
      };
    }
  }
  return { code: null, message: text };
}
