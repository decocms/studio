/**
 * Preview Setup — Empty State
 *
 * Auto-detects the dev command/port from package.json and shows
 * an editable form. On save, writes .deco/preview.json.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Loading01, Monitor01, Stars01 } from "@untitledui/icons";
import { useChatBridge } from "@decocms/mesh-sdk";
import {
  useWritePreviewConfig,
  type PreviewConfig,
} from "../hooks/use-preview-config";
import { KEYS } from "../lib/query-keys";

interface PreviewSetupProps {
  client: Client;
  connectionId: string;
  onConfigSaved: (config: PreviewConfig) => void;
}

/** Well-known framework ports */
const FRAMEWORK_PORTS: Record<string, number> = {
  next: 3000,
  vite: 5173,
  "@vitejs/plugin-react": 5173,
  "@vitejs/plugin-vue": 5173,
  nuxt: 3000,
  gatsby: 8000,
  remix: 5173,
  "@remix-run/dev": 5173,
  astro: 4321,
  "react-scripts": 3000,
};

/** Dev script names to look for, in priority order */
const DEV_SCRIPTS = ["dev", "start:dev", "serve", "start"];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function detectFromPackageJson(pkg: PackageJson): {
  command: string;
  port: number;
} {
  const scripts = pkg.scripts ?? {};
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  // Detect command
  let command = "npm run dev";
  for (const name of DEV_SCRIPTS) {
    if (scripts[name]) {
      command = `npm run ${name}`;
      break;
    }
  }

  // Detect port from framework dependencies
  let port = 3000;
  for (const [dep, defaultPort] of Object.entries(FRAMEWORK_PORTS)) {
    if (dep in allDeps) {
      port = defaultPort;
      break;
    }
  }

  return { command, port };
}

export default function PreviewSetup({
  client,
  connectionId,
  onConfigSaved,
}: PreviewSetupProps) {
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");

  const writeConfig = useWritePreviewConfig(client, connectionId);
  const chatBridge = useChatBridge();

  const handleAskAI = () => {
    if (!chatBridge) return;
    chatBridge.sendMessage(
      "Analyze this project and configure the dev server preview. " +
        "Check package.json, config files (vite.config.ts, next.config.js, etc.), " +
        "and lock files to determine the correct dev command and port. " +
        "Then write the config to .deco/preview.json.",
    );
  };

  // Auto-detect from package.json
  const { isLoading: isDetecting } = useQuery({
    queryKey: KEYS.detect(connectionId),
    queryFn: async () => {
      try {
        const result = (await client.callTool({
          name: "read_file",
          arguments: { path: "package.json" },
        })) as { content?: Array<{ type?: string; text?: string }> };

        // callTool returns { content: [{ type: "text", text: "..." }] }
        const text = result.content?.[0]?.text;

        if (text) {
          const pkg = JSON.parse(text) as PackageJson;
          const detected = detectFromPackageJson(pkg);
          setCommand((prev) => prev || detected.command);
          setPort((prev) => prev || String(detected.port));
          return detected;
        }
      } catch {
        // package.json not found or not readable
      }

      // Defaults
      setCommand((prev) => prev || "npm run dev");
      setPort((prev) => prev || "3000");
      return { command: "npm run dev", port: 3000 };
    },
    enabled: !!client,
    staleTime: Infinity,
  });

  const handleSave = () => {
    const portNum = parseInt(port, 10);
    if (!command.trim() || Number.isNaN(portNum) || portNum < 1) return;

    const config: PreviewConfig = { command: command.trim(), port: portNum };
    writeConfig.mutate(config, {
      onSuccess: () => onConfigSaved(config),
    });
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        <Monitor01 size={48} className="text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-1">Set Up Dev Preview</h2>
          <p className="text-sm text-muted-foreground">
            Configure the dev server command and port to preview your app.
          </p>
        </div>

        {isDetecting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loading01 size={16} className="animate-spin" />
            Detecting from package.json...
          </div>
        ) : (
          <div className="flex flex-col gap-4 w-full">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-command">Command</Label>
              <Input
                id="preview-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npm run dev"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-port">Port</Label>
              <Input
                id="preview-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3000"
                min={1}
                max={65535}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Button
                onClick={handleSave}
                disabled={
                  writeConfig.isPending ||
                  !command.trim() ||
                  !port ||
                  Number.isNaN(parseInt(port, 10))
                }
              >
                {writeConfig.isPending ? (
                  <>
                    <Loading01 size={14} className="mr-1 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save & Start"
                )}
              </Button>
              {chatBridge && (
                <Button variant="outline" onClick={handleAskAI}>
                  <Stars01 size={14} className="mr-1" />
                  Ask AI to detect
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
