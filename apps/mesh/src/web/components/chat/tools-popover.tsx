import {
  displayToolName,
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import {
  getPrompt,
  listPrompts,
  useConnections,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { useCurrentEditor } from "@tiptap/react";
import {
  BookOpen01,
  Image01,
  Link01,
  Loading01,
  Settings04,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "./dialog-prompt-arguments.tsx";
import { insertMention } from "./tiptap/mention";
import { KEYS } from "@/web/lib/query-keys";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { useSound } from "@/web/hooks/use-sound.ts";
import { switch005Sound } from "@deco/ui/lib/switch-005.ts";

function ConnectionIcons() {
  const connections = useConnections();
  const latest = connections?.slice(0, 3) ?? [];
  if (latest.length === 0) return null;

  return (
    <div className="flex items-center -space-x-1.5">
      {latest.map((conn) => (
        <IntegrationIcon
          key={conn.id}
          icon={conn.icon}
          name={conn.title}
          size="2xs"
          className="size-4! min-w-4! rounded-sm ring-1 ring-popover"
        />
      ))}
    </div>
  );
}

interface ToolsPopoverProps {
  disabled?: boolean;
  onOpenConnections: () => void;
  virtualMcpId: string | null;
  isAgentContext?: boolean;
}

export function ToolsPopover({
  disabled,
  onOpenConnections,
  virtualMcpId,
  isAgentContext = false,
}: ToolsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = usePreferences();
  const isPlanMode = preferences.toolApprovalLevel === "plan";
  const playSwitchSound = useSound(switch005Sound);
  const { org } = useProjectContext();
  const { editor } = useCurrentEditor();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
  });
  const queryKey = KEYS.virtualMcpPrompts(virtualMcpId, org.id);

  const { data: prompts = [], isLoading: isPromptsLoading } = useQuery({
    queryKey,
    queryFn: () => listPrompts(client!).then((r) => r.prompts ?? []),
    staleTime: 60000,
    enabled: open && !!client,
  });

  const [activePrompt, setActivePrompt] = useState<Prompt | null>(null);

  const handleTogglePlanMode = () => {
    playSwitchSound();
    setPreferences({
      ...preferences,
      toolApprovalLevel: isPlanMode ? "auto" : "plan",
    });
    setOpen(false);
  };

  const handleConnections = () => {
    onOpenConnections();
    setOpen(false);
  };

  const insertPrompt = async (
    prompt: Prompt,
    values?: PromptArgumentValues,
  ) => {
    if (!editor || !client) return;

    const clientId = getGatewayClientId(prompt._meta);
    const range = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };

    try {
      const result = await getPrompt(client, prompt.name, values);
      insertMention(editor, range, {
        id: prompt.name,
        name: stripToolNamespace(prompt.name, clientId),
        metadata: result.messages,
        char: "/",
      });
    } catch {
      toast.error("Failed to load prompt. Please try again.");
    }
  };

  const handlePromptSelect = async (prompt: Prompt) => {
    setOpen(false);
    if (prompt.arguments && prompt.arguments.length > 0) {
      setActivePrompt(prompt);
      return;
    }
    await insertPrompt(prompt);
  };

  const handlePromptArgsSubmit = async (values: PromptArgumentValues) => {
    if (!activePrompt) return;
    await insertPrompt(activePrompt, values);
    setActivePrompt(null);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings04 size={14} />
            <span className="hidden sm:inline">Tools</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 p-1.5">
          <DropdownMenuItem
            onClick={handleTogglePlanMode}
            className={cn(isPlanMode && "text-violet-600 dark:text-violet-400")}
          >
            <BookOpen01
              size={16}
              className={cn(isPlanMode && "text-violet-500")}
            />
            <span className="flex-1">Plan mode</span>
            {isPlanMode && (
              <span className="text-xs text-violet-500 font-medium">On</span>
            )}
          </DropdownMenuItem>

          <DropdownMenuItem disabled>
            <Image01 size={16} />
            <span className="flex-1">Create Image</span>
            <span className="text-xs">Soon</span>
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <span className="flex size-4 items-center justify-center text-base font-medium text-muted-foreground">
                /
              </span>
              <span className="flex-1">Prompts</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80 max-h-72 overflow-y-auto p-1.5">
              {isPromptsLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <Loading01 size={14} className="animate-spin" />
                  Loading prompts…
                </div>
              ) : prompts.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No prompts available
                </div>
              ) : (
                prompts.map((prompt) => (
                  <DropdownMenuItem
                    key={prompt.name}
                    onClick={() => handlePromptSelect(prompt)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="font-medium text-sm capitalize">
                      {prompt.title ||
                        displayToolName(
                          prompt.name,
                          getGatewayClientId(prompt._meta),
                        )}
                    </span>
                    {prompt.description && (
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {prompt.description}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {!isAgentContext && (
            <DropdownMenuItem onClick={handleConnections}>
              <Link01 size={16} />
              <span className="flex-1">Connections</span>
              <Suspense>
                <ConnectionIcons />
              </Suspense>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptArgsDialog
        prompt={activePrompt}
        setPrompt={setActivePrompt}
        onSubmit={handlePromptArgsSubmit}
      />
    </>
  );
}
