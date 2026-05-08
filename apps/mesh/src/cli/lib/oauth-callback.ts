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
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (settled) {
        return new Response("", { status: 204 });
      }
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== options.expectedState) {
        settled = true;
        rejectCallback(new Error("OAuth state mismatch"));
        return new Response("State mismatch — close this tab.", {
          status: 400,
        });
      }
      if (!code) {
        settled = true;
        rejectCallback(new Error("OAuth callback missing code"));
        return new Response("Missing code — close this tab.", { status: 400 });
      }
      settled = true;
      resolveCallback({ code });
      return new Response(SUCCESS_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    waitForCallback: () => callbackPromise,
    close: () => server.stop(true),
  };
}

const SUCCESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Login complete</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0b;color:#0f0}</style>
</head><body><div><h1>You're logged in.</h1><p>You can return to your terminal.</p></div></body></html>`;
