import { useId } from "react";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Check, Copy01 } from "@untitledui/icons";
import { connectServerName } from "@/components/connect/mcp-url";
import { useT } from "@/i18n/use-t.ts";

export type ConnectClient = "claude-code" | "cursor" | "codex" | "raw";

export type ConnectMode = "oauth" | "api-key";

interface SnippetBlock {
  language: string;
  code: string;
  /** Optional preamble line (e.g. file path the user should edit). */
  pathHint?: string;
}

function buildSnippet({
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
  const serverName = connectServerName();

  if (client === "claude-code") {
    if (mode === "oauth") {
      return {
        language: "bash",
        code: `claude mcp add --transport http --scope user ${serverName} ${url}`,
      };
    }
    return {
      language: "bash",
      code: `claude mcp add --transport http --scope user ${serverName} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
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
      code: JSON.stringify({ mcpServers: { [serverName]: server } }, null, 2),
    };
  }

  if (client === "codex") {
    const lines = [`[mcp_servers.${serverName}]`, `url = "${url}"`];
    if (mode === "api-key") {
      lines.push(`http_headers = { "Authorization" = "Bearer ${key}" }`);
    }
    return {
      language: "toml",
      pathHint: "~/.codex/config.toml",
      code: lines.join("\n"),
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
  const t = useT();
  const snippet = buildSnippet({ client, mode, url, apiKey });
  const { handleCopy, copied } = useCopy();
  const labelId = useId();
  const codeId = useId();

  return (
    /** The whole block is the copy control — clicking the label, the code or
     *  the icon all copy. One button, so there is one accessible name and no
     *  nested interactive element; the icon is decoration inside it. That name
     *  is "Copy" plus the snippet itself, so assistive tech still reads the
     *  command it is about to copy. */
    <button
      type="button"
      onClick={() => handleCopy(snippet.code)}
      aria-labelledby={`${labelId} ${codeId}`}
      className="group relative grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-md p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span id={labelId} className="sr-only">
        {t("settings.connectClients.copy")}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] leading-none text-muted-foreground">
        {snippet.pathHint ?? snippet.language}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center self-start rounded-md border border-border text-muted-foreground transition-colors",
          copied
            ? "text-success"
            : "group-hover:border-foreground/30 group-hover:text-foreground",
        )}
      >
        {copied ? <Check size={13} /> : <Copy01 size={13} />}
      </span>
      <pre className="overflow-x-auto pt-2 font-mono text-xs leading-relaxed">
        <code id={codeId}>{snippet.code}</code>
      </pre>
    </button>
  );
}
