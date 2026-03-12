/**
 * Local MCP Client
 *
 * Creates an in-process MCP client for local folder connections.
 * Instead of proxying HTTP requests to an external server, this registers
 * filesystem + bash + object-storage tools directly and communicates
 * via an in-memory bridge transport (zero serialization overhead).
 *
 * LocalFileStorage is cached per rootPath. McpServer instances are created
 * fresh per client because the MCP SDK only allows one transport per server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createBridgeTransportPair } from "@decocms/mesh-sdk";
import {
  LocalFileStorage,
  registerTools,
  registerBashTool,
} from "@decocms/local-dev";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { getInternalUrl } from "@/core/server-constants";

/** Name of the preview tool — used for sidebar pinning */
export const PREVIEW_TOOL_NAME = "dev_server_preview";

/**
 * Cache of LocalFileStorage instances per rootPath.
 * Storage is the expensive part (filesystem state); McpServer is cheap to create.
 */
const storageCache = new Map<string, LocalFileStorage>();

function getOrCreateStorage(rootPath: string): LocalFileStorage {
  const cached = storageCache.get(rootPath);
  if (cached) return cached;

  const storage = new LocalFileStorage(rootPath);
  storageCache.set(rootPath, storage);
  return storage;
}

/**
 * Register a preview tool that exposes an MCP UI resource.
 * The UI is an HTML page with an iframe pointing to the local dev server.
 * Config is read from `.deco/preview.json` in the project root.
 */
function registerPreviewTool(server: McpServer, rootPath: string) {
  const previewResourceUri = "ui://local-dev/preview";

  // Register the UI resource that serves the preview HTML
  server.registerResource(
    "preview",
    previewResourceUri,
    {
      description: "Dev server preview",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => ({
      contents: [
        {
          uri: previewResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: getPreviewHtml(rootPath),
        },
      ],
    }),
  );

  // Register the tool with UI metadata so Mesh discovers it
  server.registerTool(
    PREVIEW_TOOL_NAME,
    {
      title: "Dev Server Preview",
      description:
        "Preview your local dev server in an iframe. " +
        "Configure via .deco/preview.json with { command, port }.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          resourceUri: previewResourceUri,
          csp: {
            // Allow connecting to any localhost port for dev servers
            connectDomains: [
              "http://localhost:*",
              "http://127.0.0.1:*",
              "ws://localhost:*",
              "ws://127.0.0.1:*",
            ],
            frameDomains: ["http://localhost:*", "http://127.0.0.1:*"],
          },
        },
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: "Preview tool — use the UI tab to see the dev server iframe.",
        },
      ],
    }),
  );
}

/**
 * Create an in-process MCP client for a local folder connection.
 *
 * The connection must have metadata.localDevRoot set to the folder path.
 * Tools (filesystem, bash, object storage, preview) execute directly in
 * the mesh server process — no HTTP round-trip.
 */
export async function createLocalClient(
  connection: ConnectionEntity,
  rootPath: string,
): Promise<Client> {
  const storage = getOrCreateStorage(rootPath);

  // Create a fresh McpServer per client — MCP SDK only allows one transport per server
  const mcpServer = new McpServer({
    name: `local-dev-${rootPath}`,
    version: "1.0.0",
  });

  const internalUrl = getInternalUrl();
  const baseFileUrl = `${internalUrl}/api/local-dev/files/${connection.id}`;

  registerTools(mcpServer, storage, baseFileUrl);
  registerBashTool(mcpServer, rootPath);
  registerPreviewTool(mcpServer, rootPath);

  const { client: clientTransport, server: serverTransport } =
    createBridgeTransportPair();

  await mcpServer.connect(serverTransport);

  const client = new Client({
    name: "local-mcp-client",
    version: "1.0.0",
  });
  await client.connect(clientTransport);

  return client;
}

/**
 * Get the LocalFileStorage instance for a connection's root path.
 * Used by API routes (file serving, watch) to access the filesystem.
 */
export function getLocalStorage(
  rootPath: string,
): LocalFileStorage | undefined {
  return storageCache.get(rootPath);
}

/**
 * Returns the HTML for the preview UI resource.
 * This is a self-contained page that:
 * 1. Reads .deco/preview.json config via the bash tool (through AppBridge)
 * 2. Starts the dev server if not running
 * 3. Shows the dev server in an iframe
 */
function getPreviewHtml(rootPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; background: var(--app-background, #fff); color: var(--app-foreground, #111); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--app-border, #e5e5e5); background: var(--app-surface, #fafafa); flex-shrink: 0; }
  .toolbar button { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--app-border, #e5e5e5); background: var(--app-surface, #fff); cursor: pointer; font-size: 13px; color: inherit; }
  .toolbar button:hover { background: var(--app-muted, #f0f0f0); }
  .toolbar button.primary { background: var(--app-primary, #2563eb); color: white; border-color: transparent; }
  .toolbar button.primary:hover { opacity: 0.9; }
  .toolbar button.danger { color: #dc2626; }
  .url-bar { flex: 1; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--app-border, #e5e5e5); background: var(--app-background, #fff); font-size: 13px; font-family: monospace; color: var(--app-muted-foreground, #666); }
  .status { font-size: 12px; color: var(--app-muted-foreground, #888); }
  .status.running { color: #16a34a; }
  .status.stopped { color: #dc2626; }
  iframe { flex: 1; border: none; width: 100%; }
  .setup { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px; text-align: center; }
  .setup h2 { font-size: 18px; font-weight: 600; }
  .setup p { font-size: 14px; color: var(--app-muted-foreground, #666); max-width: 400px; }
  .setup .config-form { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 360px; text-align: left; }
  .setup label { font-size: 13px; font-weight: 500; }
  .setup input { padding: 8px 12px; border-radius: 6px; border: 1px solid var(--app-border, #e5e5e5); font-size: 14px; font-family: monospace; background: var(--app-background, #fff); color: inherit; }
  .detecting { animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
const ROOT = ${JSON.stringify(rootPath)};
const CONFIG_PATH = ".deco/preview.json";

let config = null;
let serverRunning = false;
let serverUrl = "";

// AppBridge communication — call tools on the host
async function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const handler = (e) => {
      const msg = e.data;
      if (msg?.id === id && msg?.jsonrpc === "2.0") {
        window.removeEventListener("message", handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    window.addEventListener("message", handler);
    window.parent.postMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    }, "*");
  });
}

async function bash(cmd) {
  const result = await callTool("bash", { cmd, timeout: 30000 });
  const text = result?.content?.[0]?.text || "{}";
  return JSON.parse(text);
}

async function loadConfig() {
  try {
    const result = await bash("cat " + CONFIG_PATH + " 2>/dev/null || echo '{}'");
    const parsed = JSON.parse(result.stdout || "{}");
    if (parsed.command && parsed.port) {
      config = parsed;
      return true;
    }
  } catch {}
  return false;
}

async function saveConfig(command, port) {
  await bash("mkdir -p .deco && cat > " + CONFIG_PATH + " << 'DECO_EOF'\\n" + JSON.stringify({ command, port }, null, 2) + "\\nDECO_EOF");
  config = { command, port };
}

async function checkServer() {
  if (!config) return false;
  try {
    const result = await bash("curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 http://localhost:" + config.port + " 2>/dev/null || echo 000");
    const code = parseInt(result.stdout || "000");
    return code > 0 && code < 500;
  } catch { return false; }
}

async function startServer() {
  if (!config) return;
  await bash("cd " + ROOT + " && nohup " + config.command + " > .deco/preview.log 2>&1 &");
  // Poll until server is up
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkServer()) { serverRunning = true; render(); return; }
  }
  render();
}

async function stopServer() {
  if (!config) return;
  await bash("lsof -ti:" + config.port + " | xargs kill -9 2>/dev/null || true");
  serverRunning = false;
  render();
}

async function detectConfig() {
  const result = await bash(\`
    if [ -f package.json ]; then
      cat package.json
    else
      echo '{}'
    fi
  \`);
  try {
    const pkg = JSON.parse(result.stdout || "{}");
    const scripts = pkg.scripts || {};

    // Detect package manager
    let pm = "npm run";
    const pmResult = await bash("[ -f bun.lockb ] && echo bun || ([ -f pnpm-lock.yaml ] && echo pnpm || ([ -f yarn.lock ] && echo yarn || echo npm))");
    const detected = (pmResult.stdout || "npm").trim();
    if (detected === "bun") pm = "bun run";
    else if (detected === "pnpm") pm = "pnpm";
    else if (detected === "yarn") pm = "yarn";

    // Detect dev command and port
    let command = "";
    let port = 3000;

    for (const key of ["dev", "start", "serve"]) {
      if (scripts[key]) {
        command = pm + " " + key;
        // Try to extract port from script
        const portMatch = scripts[key].match(/(?:--port|PORT=|:)(\\d{4,5})/);
        if (portMatch) port = parseInt(portMatch[1]);
        break;
      }
    }

    // Framework-specific port defaults
    if (scripts.dev) {
      if (scripts.dev.includes("vite")) port = 5173;
      else if (scripts.dev.includes("next")) port = 3000;
      else if (scripts.dev.includes("astro")) port = 4321;
      else if (scripts.dev.includes("nuxt")) port = 3000;
    }

    return { command, port };
  } catch { return { command: "", port: 3000 }; }
}

function render() {
  const app = document.getElementById("app");
  if (!config) {
    renderSetup(app);
  } else if (!serverRunning) {
    renderStopped(app);
  } else {
    renderRunning(app);
  }
}

function renderSetup(el) {
  el.innerHTML = \`
    <div class="setup">
      <h2>Configure Dev Server</h2>
      <p>Set the command and port for your local development server.</p>
      <div class="config-form">
        <label>Command</label>
        <input id="cmd" placeholder="bun run dev" />
        <label>Port</label>
        <input id="port" type="number" placeholder="3000" />
        <button class="primary" id="save-btn" style="padding:8px 16px; border-radius:6px; border:none; background:var(--app-primary,#2563eb); color:white; cursor:pointer; font-size:14px;">Save & Start</button>
        <button id="detect-btn" style="padding:8px 16px; border-radius:6px; border:1px solid var(--app-border,#e5e5e5); background:transparent; cursor:pointer; font-size:13px; color:var(--app-muted-foreground,#666);">Auto-detect from package.json</button>
      </div>
    </div>
  \`;
  document.getElementById("detect-btn").onclick = async () => {
    const btn = document.getElementById("detect-btn");
    btn.textContent = "Detecting...";
    btn.classList.add("detecting");
    const detected = await detectConfig();
    btn.classList.remove("detecting");
    btn.textContent = "Auto-detect from package.json";
    if (detected.command) {
      document.getElementById("cmd").value = detected.command;
      document.getElementById("port").value = detected.port;
    }
  };
  document.getElementById("save-btn").onclick = async () => {
    const cmd = document.getElementById("cmd").value.trim();
    const port = parseInt(document.getElementById("port").value) || 3000;
    if (!cmd) return;
    await saveConfig(cmd, port);
    await startServer();
  };
}

function renderStopped(el) {
  el.innerHTML = \`
    <div class="toolbar">
      <span class="status stopped">● Stopped</span>
      <span class="url-bar">http://localhost:\${config.port}</span>
      <button class="primary" id="start-btn">Start Server</button>
      <button id="edit-btn">Edit</button>
    </div>
    <div class="setup">
      <p>Dev server is not running.</p>
      <button class="primary" id="start-btn2" style="padding:10px 24px; border-radius:8px; border:none; background:var(--app-primary,#2563eb); color:white; cursor:pointer; font-size:14px;">Start Dev Server</button>
    </div>
  \`;
  const start = async () => {
    document.querySelectorAll("#start-btn, #start-btn2").forEach(b => { b.textContent = "Starting..."; b.disabled = true; });
    await startServer();
  };
  document.getElementById("start-btn").onclick = start;
  document.getElementById("start-btn2").onclick = start;
  document.getElementById("edit-btn").onclick = () => { config = null; render(); };
}

function renderRunning(el) {
  serverUrl = "http://localhost:" + config.port;
  el.innerHTML = \`
    <div class="toolbar">
      <span class="status running">● Running</span>
      <span class="url-bar">\${serverUrl}</span>
      <button id="refresh-btn">↻ Refresh</button>
      <button id="open-btn">↗ Open</button>
      <button class="danger" id="stop-btn">Stop</button>
    </div>
    <iframe id="preview-frame" src="\${serverUrl}"></iframe>
  \`;
  document.getElementById("refresh-btn").onclick = () => {
    document.getElementById("preview-frame").src = serverUrl;
  };
  document.getElementById("open-btn").onclick = () => {
    window.open(serverUrl, "_blank");
  };
  document.getElementById("stop-btn").onclick = stopServer;
}

// Initialize
(async () => {
  const hasConfig = await loadConfig();
  if (hasConfig) {
    serverRunning = await checkServer();
  }
  render();
})();
</script>
</body>
</html>`;
}
