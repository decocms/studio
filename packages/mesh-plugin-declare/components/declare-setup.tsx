/**
 * Declare Setup — Empty State
 *
 * Shown when .planning/ directory doesn't exist.
 * Offers to initialize declare-cc or ask AI to set it up.
 */

import { useState } from "react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import { Flag06, Loading01, Stars01 } from "@untitledui/icons";
import { useChatBridge } from "@decocms/mesh-sdk";

interface DeclareSetupProps {
  client: Client;
  onInitialized: () => void;
}

export default function DeclareSetup({
  client,
  onInitialized,
}: DeclareSetupProps) {
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatBridge = useChatBridge();

  const handleInitialize = async () => {
    setIsInitializing(true);
    setError(null);

    try {
      const result = (await client.callTool({
        name: "bash",
        arguments: { cmd: "npx declare-cc", timeout: 30000 },
      })) as { content?: unknown };

      // Check if .planning/ was created
      const raw = (result as { content?: unknown }).content;
      let text = "";
      if (Array.isArray(raw)) {
        const first = raw[0] as { text?: string } | undefined;
        text = first?.text ?? "";
      }

      // Check exit code from structured response
      try {
        const parsed = JSON.parse(text) as { exitCode?: number };
        if (parsed.exitCode !== 0) {
          setError("Initialization failed. Check the terminal for details.");
          setIsInitializing(false);
          return;
        }
      } catch {
        // Non-JSON response is fine, proceed
      }

      onInitialized();
    } catch {
      setError("Failed to run declare-cc. Make sure npx is available.");
    } finally {
      setIsInitializing(false);
    }
  };

  const handleAskAI = () => {
    if (!chatBridge) return;
    chatBridge.sendMessage(
      "Set up Declare for this project. Run `npx declare-cc` in the project root " +
        "to initialize the .planning/ directory with a project roadmap. " +
        "Analyze the codebase to create meaningful milestones and actions.",
    );
  };

  if (isInitializing) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="flex flex-col items-center gap-6 max-w-sm w-full">
          <Flag06 size={48} className="text-muted-foreground" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loading01 size={16} className="animate-spin" />
            Initializing declare-cc...
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

        <div className="flex flex-col gap-2 w-full">
          <Button onClick={handleInitialize}>Initialize</Button>
          {chatBridge && (
            <Button variant="outline" onClick={handleAskAI}>
              <Stars01 size={14} className="mr-1" />
              Ask AI to set up
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
