import { slugify } from "@/web/utils/slugify";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import { Check, Copy01, Key01, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, useState } from "react";
import { toast } from "sonner";

/**
 * Unicode-safe base64 encoding for browser environments
 */
function utf8ToBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary);
}

/**
 * Shared button props interfaces
 */
interface ShareButtonProps {
  url: string;
}

interface ShareWithNameProps extends ShareButtonProps {
  serverName: string;
}

/**
 * Copy URL Button Component
 */
function CopyUrlButton({ url }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Agent URL copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleCopy}
      className="h-auto py-3 px-4 flex flex-col items-center gap-2"
    >
      {copied ? (
        <Check size={20} className="text-green-600" />
      ) : (
        <Copy01 size={20} />
      )}
      <span className="text-xs font-medium">
        {copied ? "Copied!" : "Copy URL"}
      </span>
    </Button>
  );
}

/**
 * Install on Cursor Button Component
 */
function InstallCursorButton({ url, serverName }: ShareWithNameProps) {
  const handleInstall = () => {
    const slugifiedServerName = slugify(serverName);
    const connectionConfig = {
      type: "http",
      url: url,
      headers: {
        "x-mesh-client": "Cursor",
      },
    };
    const base64Config = utf8ToBase64(
      JSON.stringify(connectionConfig, null, 2),
    );
    const deeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(slugifiedServerName)}&config=${encodeURIComponent(base64Config)}`;

    window.open(deeplink, "_blank");
    toast.success("Opening Cursor...");
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleInstall}
      className="h-auto py-3 px-4 flex flex-col items-center gap-2"
    >
      <img
        src="/logos/cursor.svg"
        alt="Cursor"
        className="h-5 w-5"
        style={{
          filter:
            "brightness(0) saturate(100%) invert(11%) sepia(8%) saturate(785%) hue-rotate(1deg) brightness(95%) contrast(89%)",
        }}
      />
      <span className="text-xs font-medium">Install on Cursor</span>
    </Button>
  );
}

/**
 * Install on Claude Code Button Component
 */
function InstallClaudeButton({ url, serverName }: ShareWithNameProps) {
  const [copied, setCopied] = useState(false);

  const handleInstall = async () => {
    const slugifiedServerName = slugify(serverName);
    const connectionConfig = {
      type: "http",
      url: url,
      headers: {
        "x-mesh-client": "Claude Code",
      },
    };
    const configJson = JSON.stringify(connectionConfig, null, 2);
    const command = `claude mcp add-json "${slugifiedServerName}" '${configJson.replace(/'/g, "'\\''")}'`;

    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Claude Code command copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleInstall}
      className="h-auto py-3 px-4 flex flex-col items-center gap-2"
    >
      {copied ? (
        <Check size={20} className="text-green-600" />
      ) : (
        <img
          src="/logos/Claude Code.svg"
          alt="Claude Code"
          className="h-5 w-5"
          style={{
            filter:
              "brightness(0) saturate(100%) invert(55%) sepia(31%) saturate(1264%) hue-rotate(331deg) brightness(92%) contrast(86%)",
          }}
        />
      )}
      <span className="text-xs font-medium">
        {copied ? "Copied!" : "Install on Claude"}
      </span>
    </Button>
  );
}

/**
 * Typegen section inner — uses Suspense-based useMCPClient
 */
function TypegenSectionInner({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const mcpId = virtualMcp.id;
  const agentName = virtualMcp.title || `agent-${mcpId.slice(0, 8)}`;
  const command = apiKey
    ? `bunx @decocms/typegen@latest --mcp ${mcpId} --key ${apiKey} --output client.ts`
    : `bunx @decocms/typegen@latest --mcp ${mcpId} --key <api-key> --output client.ts`;

  const handleGenerateKey = async () => {
    setGenerating(true);
    try {
      const result = (await client.callTool({
        name: "API_KEY_CREATE",
        arguments: {
          name: `typegen-${agentName}`,
          permissions: { [mcpId]: ["*"] },
        },
      })) as { structuredContent?: { key?: string } };
      const key = result.structuredContent?.key;
      if (!key) throw new Error("No key in response");
      setApiKey(key);
    } catch {
      toast.error("Failed to generate API key");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Command copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-sm font-medium text-foreground">
            Generate typed client
          </h4>
          <p className="text-xs text-muted-foreground">
            Introspects this agent and writes a typed{" "}
            <code className="font-mono">client.ts</code> you can import
            directly.
          </p>
        </div>
        {!apiKey && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={handleGenerateKey}
            disabled={generating}
          >
            {generating ? (
              <Loading01 size={14} className="animate-spin" />
            ) : (
              <Key01 size={14} />
            )}
            <span>{generating ? "Generating…" : "Generate API key"}</span>
          </Button>
        )}
      </div>

      {apiKey && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Store this key securely — it won't be shown again.
        </p>
      )}

      <p className="text-xs font-medium text-muted-foreground">
        Generate client
      </p>
      <div className="rounded-md border border-input bg-muted/50 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
            {command}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={12} className="text-green-600" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      </div>

      <p className="text-xs font-medium text-muted-foreground">
        Runtime variables
      </p>
      <EnvVarsBlock apiKey={apiKey} />
    </div>
  );
}

function EnvVarsBlock({ apiKey }: { apiKey: string | null }) {
  const [copied, setCopied] = useState(false);
  const meshUrl = window.location.origin;
  const keyLine = apiKey ? `MESH_API_KEY=${apiKey}` : `MESH_API_KEY=<api-key>`;
  const urlLine = `MESH_BASE_URL=${meshUrl}`;
  const envBlock = `${keyLine}\n${urlLine}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(envBlock);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md border border-input bg-muted/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
          <span className={cn({ "opacity-50": !apiKey })}>{keyLine}</span>
          <br />
          <span>{urlLine}</span>
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={handleCopy}
        >
          {copied ? (
            <Check size={12} className="text-green-600" />
          ) : (
            <Copy01 size={12} />
          )}
        </Button>
      </div>
    </div>
  );
}

function TypegenSection({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  return (
    <Suspense
      fallback={<div className="h-20 animate-pulse rounded-md bg-muted" />}
    >
      <TypegenSectionInner virtualMcp={virtualMcp} />
    </Suspense>
  );
}

/**
 * Share Modal - Virtual MCP sharing and IDE integration
 */
export function VirtualMCPShareModal({
  open,
  onOpenChange,
  virtualMcp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualMcp: VirtualMCPEntity;
}) {
  // Virtual MCPs (agents) are accessed via the virtual-mcp endpoint
  const virtualMcpUrl = new URL(
    `/mcp/virtual-mcp/${virtualMcp.id}`,
    window.location.origin,
  );

  // Server name for IDE integrations
  const serverName =
    virtualMcp.title || `agent-${virtualMcp.id?.slice(0, 8) ?? "default"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          {/* Mode Selection */}
          {/* Action Buttons */}
          <div className="flex flex-col gap-3 pt-2">
            <div className="grid grid-cols-3 gap-2">
              <CopyUrlButton url={virtualMcpUrl.href} />
              <InstallCursorButton
                url={virtualMcpUrl.href}
                serverName={serverName}
              />
              <InstallClaudeButton
                url={virtualMcpUrl.href}
                serverName={serverName}
              />
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Typegen */}
          <TypegenSection virtualMcp={virtualMcp} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
