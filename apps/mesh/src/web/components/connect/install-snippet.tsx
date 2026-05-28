import { Button } from "@deco/ui/components/button.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { Check, Copy01 } from "@untitledui/icons";

export type ConnectClient =
  | "claude-code"
  | "cursor"
  | "codex"
  | "claude-desktop"
  | "raw";

export type ConnectMode = "oauth" | "api-key";

const SERVER_NAME = "studio";

interface SnippetBlock {
  language: string;
  code: string;
  /** Optional preamble line (e.g. file path the user should edit). */
  pathHint?: string;
}

export function buildSnippet({
  client,
  mode,
  url,
  apiKey,
}: {
  client: ConnectClient;
  mode: ConnectMode;
  url: string;
  apiKey?: string;
}): SnippetBlock {
  const key = apiKey ?? "<paste-your-api-key>";

  if (client === "claude-code") {
    if (mode === "oauth") {
      return {
        language: "bash",
        code: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`,
      };
    }
    return {
      language: "bash",
      code: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
    };
  }

  if (client === "cursor") {
    const server: Record<string, unknown> = { url };
    if (mode === "api-key") {
      server.headers = { Authorization: `Bearer ${key}` };
    }
    return {
      language: "json",
      pathHint: "~/.cursor/mcp.json",
      code: JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2),
    };
  }

  if (client === "codex") {
    const lines = [`[mcp_servers.${SERVER_NAME}]`, `url = "${url}"`];
    if (mode === "api-key") {
      lines.push(`http_headers = { "Authorization" = "Bearer ${key}" }`);
    }
    return {
      language: "toml",
      pathHint: "~/.codex/config.toml",
      code: lines.join("\n"),
    };
  }

  if (client === "claude-desktop") {
    const server: Record<string, unknown> = { type: "http", url };
    if (mode === "api-key") {
      server.headers = { Authorization: `Bearer ${key}` };
    }
    return {
      language: "json",
      pathHint: "claude_desktop_config.json",
      code: JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2),
    };
  }

  // raw
  if (mode === "oauth") {
    return {
      language: "text",
      code: `${url}\n\n# OAuth: clients that support MCP OAuth 2.1 will discover\n# the auth flow via the WWW-Authenticate header on 401.`,
    };
  }
  return {
    language: "text",
    code: `${url}\n\nAuthorization: Bearer ${key}`,
  };
}

export function InstallSnippet({
  client,
  mode,
  url,
  apiKey,
}: {
  client: ConnectClient;
  mode: ConnectMode;
  url: string;
  apiKey?: string;
}) {
  const snippet = buildSnippet({ client, mode, url, apiKey });
  const { handleCopy, copied } = useCopy();

  return (
    <div className="relative rounded-md border border-border bg-muted/40">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          {snippet.pathHint ?? snippet.language}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => handleCopy(snippet.code)}
          aria-label="Copy snippet"
        >
          {copied ? <Check size={14} /> : <Copy01 size={14} />}
        </Button>
      </div>
      <pre className="p-3 text-xs overflow-x-auto font-mono">
        <code>{snippet.code}</code>
      </pre>
    </div>
  );
}
