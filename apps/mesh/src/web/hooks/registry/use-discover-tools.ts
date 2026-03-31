import { useState } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { RegistryToolMeta } from "@/web/lib/registry/types";

interface DiscoverToolsResponse {
  tools: RegistryToolMeta[];
  error?: string | null;
}

interface ToolResult<T> {
  structuredContent?: T;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

export type DiscoverStatus =
  | "idle"
  | "loading"
  | "success"
  | "error"
  | "auth_required";

export function useDiscoverTools() {
  const [discoverStatus, setDiscoverStatus] = useState<DiscoverStatus>("idle");
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const discover = async (
    remoteUrl: string,
    remoteType: string,
  ): Promise<RegistryToolMeta[] | null> => {
    if (!remoteUrl) return null;
    setDiscoverStatus("loading");
    setDiscoverError(null);

    try {
      const result = (await client.callTool({
        name: "REGISTRY_DISCOVER_TOOLS",
        arguments: {
          url: remoteUrl,
          type: remoteType === "sse" ? "sse" : "http",
        },
      })) as ToolResult<DiscoverToolsResponse>;

      const data = (result.structuredContent ??
        result) as DiscoverToolsResponse;

      if (result.isError) {
        const message =
          result.content?.find((item) => item.type === "text")?.text ??
          "Tool returned an error";
        setDiscoverError(message);
        setDiscoverStatus("error");
        return null;
      }

      if (data.error) {
        // Detect auth-required errors — server IS reachable but needs credentials
        if (isAuthError(data.error)) {
          setDiscoverError(data.error);
          setDiscoverStatus("auth_required");
          return null;
        }
        setDiscoverError(data.error);
        setDiscoverStatus("error");
        return null;
      }

      if (!data.tools || data.tools.length === 0) {
        setDiscoverError("No tools found on this MCP server.");
        setDiscoverStatus("error");
        return null;
      }

      setDiscoverStatus("success");
      return data.tools;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDiscoverError(message || "Could not discover tools.");
      setDiscoverStatus("error");
      return null;
    }
  };

  const resetDiscover = () => {
    setDiscoverStatus("idle");
    setDiscoverError(null);
  };

  return { discover, discoverStatus, discoverError, resetDiscover };
}

function isAuthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("credentials")
  );
}
