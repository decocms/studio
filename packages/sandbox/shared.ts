export const PLUGIN_ID = "MCP User Sandbox";
export const PLUGIN_DESCRIPTION =
  "Isolated per-user sandboxes for MCP tool execution";

export const DAEMON_PORT = 9000;
export const DEFAULT_IMAGE = "studio-sandbox:local";

/** Shell-quote a value for safe inclusion in a `bash -lc` script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prepend to any clone script; callers own the clone strategy themselves. */
export function gitIdentityScript(userName: string, userEmail: string): string {
  return `git config --global user.name ${shellQuote(userName)} && git config --global user.email ${shellQuote(userEmail)}`;
}

/**
 * Injected into proxied dev-server HTML. Two jobs:
 * 1. WebSocket rewriter — Vite/Fresh/Next/Webpack/Bun bake the dev WS URL
 *    (container-internal host:port) at startup; inside mesh's iframe under
 *    `/api/sandbox/.../preview/<port>/` those URLs don't route. We patch
 *    `WebSocket` so loopback/same-hostname-different-port URLs are rewritten
 *    to the iframe origin + same proxy prefix, so HMR lands on the daemon.
 * 2. Visual-editor activation via `visual-editor::activate` postMessage.
 * Must run before the framework builds its WS — spliced after `<head>` by
 * `injectBootstrap` in image/daemon/proxy.mjs.
 */
export const IFRAME_BOOTSTRAP_SCRIPT = `<script>(function(){try{var W=window.WebSocket;if(W){var m=location.pathname.match(/^(\\/api\\/sandbox\\/[^\\/]+(?:\\/thread\\/[^\\/]+)?\\/preview(?:\\/\\d+)?)/);var p=m?m[1]:"";function r(u){try{var x=new URL(String(u),location.href);var lb=x.hostname==="localhost"||x.hostname==="127.0.0.1"||x.hostname==="0.0.0.0";var pm=x.hostname===location.hostname&&x.port!==location.port&&x.port!=="";if(!lb&&!pm)return String(u);x.protocol=location.protocol==="https:"?"wss:":"ws:";x.host=location.host;if(p&&!x.pathname.startsWith(p))x.pathname=p+x.pathname;return x.toString();}catch(_){return String(u);}}class P extends W{constructor(u,pr){super(r(u),pr);}}window.WebSocket=P;}}catch(_){}window.addEventListener("message",function(e){if(e.data&&e.data.type==="visual-editor::activate"&&e.data.script){try{new Function(e.data.script)();}catch(err){console.error("[visual-editor] injection failed",err);}}});})();</script>`;
