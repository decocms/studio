import { slugify } from "@/shared/utils/slugify";
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
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import { Check, Copy01, Key01, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { track } from "@/web/lib/posthog-client";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useT } from "@/web/i18n/use-t.ts";

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
  agentId: string;
}

interface ShareWithNameProps extends ShareButtonProps {
  serverName: string;
}

/**
 * Copy URL Button Component
 */
function CopyUrlButton({ url, agentId }: ShareButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    track("agent_connect_action", {
      agent_id: agentId,
      action: "copy_url",
    });
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success(t("virtualMcp.virtualMcpShareModal.agentUrlCopied"));
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
        <Check size={20} className="text-success" />
      ) : (
        <Copy01 size={20} />
      )}
      <span className="text-xs font-medium">
        {copied
          ? t("virtualMcp.virtualMcpShareModal.copied")
          : t("virtualMcp.virtualMcpShareModal.copyUrl")}
      </span>
    </Button>
  );
}

/**
 * Install on Cursor Button Component
 */
function InstallCursorButton({ url, serverName, agentId }: ShareWithNameProps) {
  const t = useT();
  const handleInstall = () => {
    track("agent_connect_action", {
      agent_id: agentId,
      action: "install_cursor",
    });
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
    toast.success(t("virtualMcp.virtualMcpShareModal.openingCursor"));
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
      <span className="text-xs font-medium">
        {t("virtualMcp.virtualMcpShareModal.installOnCursor")}
      </span>
    </Button>
  );
}

/**
 * Install on Claude Code Button Component
 */
function InstallClaudeButton({ url, serverName, agentId }: ShareWithNameProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleInstall = async () => {
    track("agent_connect_action", {
      agent_id: agentId,
      action: "install_claude_code",
    });
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
    toast.success(t("virtualMcp.virtualMcpShareModal.claudeCodeCommandCopied"));
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
        <Check size={20} className="text-success" />
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
        {copied
          ? t("virtualMcp.virtualMcpShareModal.copied")
          : t("virtualMcp.virtualMcpShareModal.installOnClaudeCode")}
      </span>
    </Button>
  );
}

/**
 * Typegen section inner — calls builtin tools via useStudioTools
 */
function TypegenSectionInner({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  const t = useT();
  const studio = useStudioTools();
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
      const { key } = await studio.call("API_KEY_CREATE", {
        name: `typegen-${agentName}`,
        permissions: { [mcpId]: ["*"] },
      });
      if (!key) throw new Error("No key in response");
      setApiKey(key);
      track("agent_typegen_key_generated", { agent_id: mcpId });
    } catch {
      track("agent_typegen_key_failed", { agent_id: mcpId });
      toast.error(t("virtualMcp.virtualMcpShareModal.failedGenerateApiKey"));
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    track("agent_connect_action", {
      agent_id: mcpId,
      action: "typegen_copy_command",
      has_api_key: Boolean(apiKey),
    });
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success(t("virtualMcp.virtualMcpShareModal.commandCopied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-sm font-medium text-foreground">
            {t("virtualMcp.virtualMcpShareModal.generateTypedClient")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(
              "virtualMcp.virtualMcpShareModal.generateTypedClientDescription",
            )}
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
            <span>
              {generating
                ? t("virtualMcp.virtualMcpShareModal.generating")
                : t("virtualMcp.virtualMcpShareModal.generateApiKey")}
            </span>
          </Button>
        )}
      </div>

      {apiKey && (
        <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          {t("virtualMcp.virtualMcpShareModal.storeKeySecurely")}
        </p>
      )}

      <p className="text-xs font-medium text-muted-foreground">
        {t("virtualMcp.virtualMcpShareModal.generateClientLabel")}
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
              <Check size={12} className="text-success" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      </div>

      <p className="text-xs font-medium text-muted-foreground">
        {t("virtualMcp.virtualMcpShareModal.runtimeVariables")}
      </p>
      <EnvVarsBlock apiKey={apiKey} agentId={mcpId} />
    </div>
  );
}

function EnvVarsBlock({
  apiKey,
  agentId,
}: {
  apiKey: string | null;
  agentId: string;
}) {
  const [copied, setCopied] = useState(false);
  const meshUrl = window.location.origin;
  const keyLine = apiKey
    ? `STUDIO_API_KEY=${apiKey}`
    : `STUDIO_API_KEY=<api-key>`;
  const urlLine = `STUDIO_BASE_URL=${meshUrl}`;
  const envBlock = `${keyLine}\n${urlLine}`;

  const handleCopy = async () => {
    track("agent_connect_action", {
      agent_id: agentId,
      action: "typegen_copy_env",
      has_api_key: Boolean(apiKey),
    });
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
            <Check size={12} className="text-success" />
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
 * Permissions for an "agent chat bridge" API key: enough to create a thread,
 * run this agent, and read the thread back from an external app. The run and
 * stream endpoints only require org membership, so no connection-scoped grant
 * is needed — just the thread tools on `self`.
 */
const CHAT_BRIDGE_PERMISSIONS: Record<string, string[]> = {
  self: [
    "COLLECTION_THREADS_CREATE",
    "COLLECTION_THREADS_GET",
    "COLLECTION_THREAD_MESSAGES_LIST",
    "COLLECTION_THREADS_LIST",
  ],
};
const CHAT_BRIDGE_EXPIRES_IN = 60 * 60 * 24 * 90; // 90 days

/**
 * Chat bridge section — mints a scoped API key for driving this agent from an
 * external system (create thread → POST messages → stream → read thread back).
 */
function ChatBridgeSectionInner({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const t = useT();
  const studio = useStudioTools();
  const { org } = useProjectContext();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const mcpId = virtualMcp.id;
  const agentName = virtualMcp.title || `agent-${mcpId.slice(0, 8)}`;
  const baseUrl = window.location.origin;

  const envBlock = [
    `STUDIO_BASE_URL=${baseUrl}`,
    `STUDIO_ORG=${org.slug}`,
    `STUDIO_AGENT_ID=${mcpId}`,
    `STUDIO_API_KEY=${apiKey ?? "<api-key>"}`,
  ].join("\n");

  const handleGenerateKey = async () => {
    setGenerating(true);
    try {
      const { key } = await studio.call("API_KEY_CREATE", {
        name: `chat-bridge-${agentName}`,
        permissions: CHAT_BRIDGE_PERMISSIONS,
        expiresIn: CHAT_BRIDGE_EXPIRES_IN,
      });
      if (!key) throw new Error("No key in response");
      setApiKey(key);
      track("agent_chat_bridge_key_generated", { agent_id: mcpId });
    } catch {
      track("agent_chat_bridge_key_failed", { agent_id: mcpId });
      toast.error(t("virtualMcp.virtualMcpShareModal.failedCreateApiKey"));
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    track("agent_connect_action", {
      agent_id: mcpId,
      action: "chat_bridge_copy_env",
      has_api_key: Boolean(apiKey),
    });
    await navigator.clipboard.writeText(envBlock);
    setCopied(true);
    toast.success(t("virtualMcp.virtualMcpShareModal.connectionDetailsCopied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-sm font-medium text-foreground">
            {t("virtualMcp.virtualMcpShareModal.callFromYourApp")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("virtualMcp.virtualMcpShareModal.callFromYourAppDescription")}
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
            <span>
              {generating
                ? t("virtualMcp.virtualMcpShareModal.creating")
                : t("virtualMcp.virtualMcpShareModal.createApiKey")}
            </span>
          </Button>
        )}
      </div>

      {apiKey && (
        <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          {t("virtualMcp.virtualMcpShareModal.storeKeySecurely")}
        </p>
      )}

      <p className="text-xs font-medium text-muted-foreground">
        {t("virtualMcp.virtualMcpShareModal.connectionDetails")}
      </p>
      <div className="rounded-md border border-input bg-muted/50 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
            {envBlock}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={12} className="text-success" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBridgeSection({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  return (
    <Suspense
      fallback={<div className="h-20 animate-pulse rounded-md bg-muted" />}
    >
      <ChatBridgeSectionInner virtualMcp={virtualMcp} />
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
  const t = useT();
  const { org } = useProjectContext();
  // Virtual MCPs (agents) are accessed via the virtual-mcp endpoint
  const virtualMcpUrl = new URL(
    `/api/${org.slug}/mcp/virtual-mcp/${virtualMcp.id}`,
    window.location.origin,
  );

  // Server name for IDE integrations
  const serverName =
    virtualMcp.title || `agent-${virtualMcp.id?.slice(0, 8) ?? "default"}`;

  const isMobile = useIsMobile();

  const content = (
    <div className="flex flex-col gap-6">
      {/* Action Buttons */}
      <div className="flex flex-col gap-3 pt-2">
        <div className="grid grid-cols-3 gap-2">
          <CopyUrlButton url={virtualMcpUrl.href} agentId={virtualMcp.id} />
          <InstallCursorButton
            url={virtualMcpUrl.href}
            serverName={serverName}
            agentId={virtualMcp.id}
          />
          <InstallClaudeButton
            url={virtualMcpUrl.href}
            serverName={serverName}
            agentId={virtualMcp.id}
          />
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Typegen */}
      <TypegenSection virtualMcp={virtualMcp} />

      <div className="border-t border-border" />

      {/* Chat bridge — scoped key for external integrations */}
      <ChatBridgeSection virtualMcp={virtualMcp} />
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="flex-1 overflow-y-auto px-4 pb-6 [touch-action:pan-y]">
            <DrawerTitle className="mt-4 mb-4 text-base font-semibold">
              {t("virtualMcp.virtualMcpShareModal.connect")}
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
          <DialogTitle>
            {t("virtualMcp.virtualMcpShareModal.connect")}
          </DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
