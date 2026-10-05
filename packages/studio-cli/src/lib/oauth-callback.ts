import { createServer } from "node:http";

export interface OAuthCallback {
  code: string;
}

export interface OAuthCallbackServer {
  url: string;
  waitForCallback: () => Promise<OAuthCallback>;
  /** Always call this after waitForCallback resolves or rejects (e.g., via try/finally). */
  close: () => void;
}

export interface StartOptions {
  expectedState: string;
  /**
   * Absolute URL the browser is redirected to after a successful callback.
   * The CLI typically points this at the studio's `/cli/auth-success`
   * route so the user lands on a polished, personalized success page
   * instead of inline localhost HTML.
   */
  successRedirectUrl: string;
  /** If provided, bind to this port. Defaults to 0 (OS-chosen). */
  port?: number;
}

export async function startOAuthCallbackServer(
  options: StartOptions,
): Promise<OAuthCallbackServer> {
  let resolveCallback!: (value: OAuthCallback) => void;
  let rejectCallback!: (err: Error) => void;
  const callbackPromise = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Suppress unhandled-rejection warnings; callers consume via waitForCallback().
  callbackPromise.catch(() => {});

  let settled = false;
  const server = createServer((req, res) => {
    if (settled) {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    settled = true;
    if (state !== options.expectedState) {
      rejectCallback(new Error("OAuth state mismatch"));
      res.writeHead(400).end("State mismatch — close this tab.");
      return;
    }
    if (!code) {
      rejectCallback(new Error("OAuth callback missing code"));
      res.writeHead(400).end("Missing code — close this tab.");
      return;
    }
    resolveCallback({ code });
    res.writeHead(302, { location: options.successRedirectUrl }).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback server did not bind a TCP port");
  }
  const { port } = address;

  return {
    url: `http://127.0.0.1:${port}`,
    waitForCallback: () => callbackPromise,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
