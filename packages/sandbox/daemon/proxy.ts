import { BOOTSTRAP_SCRIPT } from "./constants";
import type { Broadcaster } from "./events/broadcast";
import { fetchLoopback } from "./upstream-fetch";

export interface ProxyDeps {
  broadcaster: Broadcaster;
  getDevPort: () => number | null;
}

const NO_UPSTREAM_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>No dev server</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}code{background:#eee;padding:2px 6px;border-radius:4px;font-size:13px;color:#333}</style></head><body><div><h3>No dev server running</h3><p>Start one in this sandbox (e.g. <code>bun run dev</code>) and the preview will appear here automatically.</p></div><script>setTimeout(function(){window.location.reload()},2000)</script></body></html>`;

export function makeProxyHandler({ broadcaster, getDevPort }: ProxyDeps) {
  function log(...args: string[]) {
    const msg = `[daemon] ${new Date().toISOString()} ${args.join(" ")}`;
    broadcaster.broadcastChunk("daemon", msg + "\r\n");
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const port = getDevPort();
    if (port === null) {
      return new Response(NO_UPSTREAM_HTML, {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    log("proxy", req.method, url.pathname);
    const outHeaders = new Headers(req.headers);
    outHeaders.delete("accept-encoding");
    outHeaders.delete("host");
    outHeaders.delete("transfer-encoding");
    outHeaders.delete("content-length");
    outHeaders.delete("authorization");

    // 60s timeout guards the *headers* phase — a hung dev server shouldn't
    // pin a request slot forever. Once headers arrive we cancel the timer:
    // SSE / NDJSON / long-poll bodies must be allowed to stream indefinitely.
    // Client-disconnect aborts upstream too, so we don't leak a fetch when
    // the browser navigates away mid-stream.
    const upstreamAbort = new AbortController();
    const headersTimeout = setTimeout(
      () => upstreamAbort.abort(new Error("upstream headers timeout")),
      60000,
    );
    const onClientAbort = () => upstreamAbort.abort();
    req.signal.addEventListener("abort", onClientAbort, { once: true });

    let upstream: Response;
    try {
      const init: RequestInit = {
        method: req.method,
        headers: outHeaders,
        redirect: "manual",
        signal: upstreamAbort.signal,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await req.arrayBuffer();
      }
      upstream = await fetchLoopback(
        port,
        `${url.pathname}${url.search}`,
        init,
      );
      clearTimeout(headersTimeout);
    } catch (e) {
      clearTimeout(headersTimeout);
      req.signal.removeEventListener("abort", onClientAbort);
      const msg = (e as Error).message ?? String(e);
      log("proxy error", req.method, url.pathname, msg);
      const connErr =
        /ECONNREFUSED|ECONNRESET|ECONNABORTED|fetch failed|Unable to connect|TimeoutError|timed out/i.test(
          msg,
        );
      if (url.pathname === "/" && connErr) {
        // Reaching this branch means we *did* have a port at the top of the
        // handler but the upstream just failed: server is mid-restart, mid-
        // compile, or briefly unhealthy. Auto-reload is the right call.
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting...</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center}p{margin-top:8px;font-size:14px;color:#999}</style></head><body><div><h3>Server is starting…</h3><p>This page will refresh automatically.</p></div><script>setTimeout(function(){window.location.reload()},1000)</script></body></html>`,
          {
            status: 503,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Retry-After": "1",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      return new Response(JSON.stringify({ error: `proxy error: ${msg}` }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("x-frame-options");
    respHeaders.delete("content-security-policy");
    respHeaders.delete("content-security-policy-report-only");
    respHeaders.delete("content-encoding");

    const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/html")) {
      respHeaders.delete("content-length");
      let html = await upstream.text();
      const idx = html.lastIndexOf("</body>");
      html =
        idx !== -1
          ? html.slice(0, idx) + BOOTSTRAP_SCRIPT + html.slice(idx)
          : html + BOOTSTRAP_SCRIPT;
      return new Response(html, {
        status: upstream.status,
        headers: respHeaders,
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  };
}
