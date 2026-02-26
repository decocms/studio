/**
 * Declare Setup — Empty State
 *
 * Shown when .planning/ directory doesn't exist.
 * Flow:
 * 1. Install declare-cc as devDependency
 * 2. Run `npx dcl` which auto-inits .planning/, starts server, writes server.port
 * 3. Poll for server.port to appear → transition to dashboard
 */

import { useState } from "react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import { Flag06, Loading01 } from "@untitledui/icons";

interface DeclareSetupProps {
  client: Client;
  onInitialized: () => void;
}

/** Extract text from an MCP tool result. */
function extractText(result: { content?: unknown }): string {
  const raw = result.content;
  if (Array.isArray(raw)) {
    const first = raw[0] as { text?: string } | undefined;
    return first?.text ?? "";
  }
  if (typeof raw === "string") return raw;
  return "";
}

/** Parse bash tool response to get exit code. */
function parseExitCode(text: string): number {
  try {
    const parsed = JSON.parse(text) as { exitCode?: number };
    return parsed.exitCode ?? 0;
  } catch {
    return 0;
  }
}

export default function DeclareSetup({
  client,
  onInitialized,
}: DeclareSetupProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setIsStarting(true);
    setError(null);

    try {
      // Step 1: Install declare-cc as devDependency
      setStatus("Installing declare-cc...");
      const installResult = (await client.callTool({
        name: "bash",
        arguments: {
          cmd: "npm install --save-dev declare-cc@latest 2>&1 || bun add --dev declare-cc@latest 2>&1",
          timeout: 60000,
        },
      })) as { content?: unknown };

      const installText = extractText(installResult);
      if (parseExitCode(installText) !== 0) {
        // Try the raw output — npm might have succeeded even with exit code issues
        // Continue anyway since the package might already be installed
      }

      // Step 2: Start dcl (auto-inits .planning/ + starts server + writes port)
      setStatus("Starting declare server...");
      await client.callTool({
        name: "bash",
        arguments: {
          cmd: "nohup npx dcl > /tmp/dcl-init.log 2>&1 &",
          timeout: 0,
        },
      });

      // Step 3: Poll for .planning/server.port to appear
      setStatus("Waiting for server...");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1_500));
        const checkResult = (await client.callTool({
          name: "bash",
          arguments: { cmd: "cat .planning/server.port 2>/dev/null" },
        })) as { content?: unknown };

        const text = extractText(checkResult);
        try {
          const parsed = JSON.parse(text) as {
            stdout?: string;
            exitCode?: number;
          };
          if (parsed.exitCode === 0 && parsed.stdout?.trim()) {
            onInitialized();
            return;
          }
        } catch {
          if (text.trim() && /^\d+$/.test(text.trim())) {
            onInitialized();
            return;
          }
        }
      }

      setError("Server didn't start within 30s. Check the terminal output.");
    } catch (e) {
      setError(
        `Failed to initialize: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      setIsStarting(false);
    }
  };

  if (isStarting) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="flex flex-col items-center gap-6 max-w-sm w-full">
          <Flag06 size={48} className="text-muted-foreground" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loading01 size={16} className="animate-spin" />
            {status}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        <Flag06 size={48} className="text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-1">Set Up Declare</h2>
          <p className="text-sm text-muted-foreground">
            Plan your project with declarations, milestones, and actions.
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive text-center">{error}</p>
        )}

        <Button onClick={handleStart}>Initialize</Button>
      </div>
    </div>
  );
}
