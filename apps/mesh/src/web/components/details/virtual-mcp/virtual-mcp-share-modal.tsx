import { slugify } from "@/web/utils/slugify";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@deco/ui/components/radio-group.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import {
  ArrowsRight,
  Check,
  Code01,
  Copy01,
  InfoCircle,
  Key01,
  Lightbulb02,
  Loading01,
} from "@untitledui/icons";
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
    const command = `claude mcp add-json "${slugifiedServerName}" '${configJson.replace(/'/g, "'\\''")}'  --scope user`;

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
  const [mode, setMode] = useState<
    "passthrough" | "smart_tool_selection" | "code_execution"
  >("code_execution");

  const handleModeChange = (value: string) => {
    if (
      value === "passthrough" ||
      value === "smart_tool_selection" ||
      value === "code_execution"
    ) {
      setMode(value);
    }
  };

  // Build URL with mode query parameter
  // Virtual MCPs (agents) are accessed via the virtual-mcp endpoint
  const virtualMcpUrl = new URL(
    `/mcp/virtual-mcp/${virtualMcp.id}`,
    window.location.origin,
  );
  virtualMcpUrl.searchParams.set("mode", mode);

  // Server name for IDE integrations
  const serverName =
    virtualMcp.title || `agent-${virtualMcp.id?.slice(0, 8) ?? "default"}`;

  const isMobile = useIsMobile();

  const content = (
    <div className="flex flex-col gap-6">
      {/* Mode Selection */}
      <div className="flex flex-col gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground mt-1">
            How should this agent work?
          </h4>
        </div>
        <RadioGroup
          value={mode}
          onValueChange={handleModeChange}
          className="flex flex-col gap-4.5"
        >
          {/* Passthrough Option */}
          <label
            htmlFor="mode-passthrough"
            className="flex items-center gap-3 px-3 py-5 rounded-lg border border-border hover:border-ring/50 cursor-pointer transition-colors has-checked:border-ring has-checked:bg-accent/5"
          >
            <div className="p-1.5 shrink-0">
              <ArrowsRight className="size-5 text-muted-foreground" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Direct access
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InfoCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs">
                        All tools are exposed directly via tools/list. Best for
                        small tool surfaces with deterministic behavior.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Best for small teams or when you need predictable behavior
              </p>
            </div>
            <RadioGroupItem id="mode-passthrough" value="passthrough" />
          </label>

          {/* Smart Tool Selection Option */}
          <label
            htmlFor="mode-smart"
            className="flex items-center gap-3 px-3 py-5 rounded-lg border border-border hover:border-ring/50 cursor-pointer transition-colors has-checked:border-ring has-checked:bg-accent/5"
          >
            <div className="p-1.5 shrink-0">
              <Lightbulb02 className="size-5 text-muted-foreground" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Smart discovery
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InfoCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs">
                        Uses meta-tools (GATEWAY_SEARCH_TOOLS,
                        GATEWAY_DESCRIBE_TOOLS, GATEWAY_CALL_TOOL) to keep the
                        tool list small and request details on demand.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Ideal for large teams with many tools - AI finds what it needs
              </p>
            </div>
            <RadioGroupItem id="mode-smart" value="smart_tool_selection" />
          </label>

          {/* Code Execution Option */}
          <label
            htmlFor="mode-code"
            className="relative flex items-center gap-3 px-3 py-5 rounded-lg border border-border hover:border-ring/50 cursor-pointer transition-colors has-checked:border-ring has-checked:bg-accent/5"
          >
            <div className="p-1.5 shrink-0">
              <Code01 className="size-5 text-muted-foreground" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Smart execution
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InfoCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="text-xs">
                        Exposes meta-tools for discovery + sandboxed execution
                        (GATEWAY_RUN_CODE). Reduces overhead on large surfaces
                        by shifting work into a controlled runtime.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Maximum flexibility - AI can write code to orchestrate tools
              </p>
            </div>
            <RadioGroupItem id="mode-code" value="code_execution" />
            <Badge
              variant="outline"
              className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-background z-10"
            >
              Recommended
            </Badge>
          </label>
        </RadioGroup>
      </div>

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
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="flex-1 overflow-y-auto px-4 pb-6 [touch-action:pan-y]">
            <DrawerTitle className="mt-4 mb-4 text-base font-semibold">
              Connect
            </DrawerTitle>
            {content}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
