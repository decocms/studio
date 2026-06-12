/**
 * New task — a prompt-first create dialog. The prompt is the task: it is
 * handed to the new thread via the autosend channel (the same handoff the
 * chat uses for follow-up tasks), so the agent starts working immediately.
 * An agent picker chooses which vMCP runs it (default: Decopilot).
 */

import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ChevronRight, Cube01, X } from "@untitledui/icons";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import type { TiptapDoc } from "@/web/components/chat/types";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/web/lib/autosend";

function promptDoc(text: string): TiptapDoc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export function NewTaskDialog({
  open,
  onClose,
  orgName,
  orgLogo,
}: {
  open: boolean;
  onClose: () => void;
  orgName: string;
  orgLogo: string | null;
}) {
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const { org: organization, locator } = useProjectContext();
  const actions = useThreadActions();
  const agents = useVirtualMCPs();
  const decopilot = getWellKnownDecopilotVirtualMCP(organization.id);

  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string>(decopilot.id);
  const [creating, setCreating] = useState(false);

  const agentOptions = [
    { id: decopilot.id, title: decopilot.title, icon: decopilot.icon },
    ...agents.map((a) => ({ id: a.id, title: a.title, icon: a.icon })),
  ];
  const selectedAgent =
    agentOptions.find((a) => a.id === agentId) ?? agentOptions[0]!;

  const reset = () => {
    setPrompt("");
    setAgentId(decopilot.id);
    setCreating(false);
  };

  const submit = async () => {
    const text = prompt.trim();
    if (!text || !org || creating) return;
    setCreating(true);
    const taskId = crypto.randomUUID();
    // Stage the message first so the new task's chat finds it on mount even
    // if navigation lands before the create round-trip settles.
    writeStoredAutosend(sessionStorage, locator, taskId, {
      tiptapDoc: promptDoc(text),
    });
    try {
      await actions.create({ id: taskId, virtual_mcp_id: agentId });
    } finally {
      setCreating(false);
    }
    reset();
    onClose();
    navigate({
      to: "/$org/$taskId",
      params: { org, taskId },
      search: { virtualmcpid: agentId, autosend: AUTOSEND_QUERY_VALUE },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-[640px]"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">New task</DialogTitle>

        {/* Header — org breadcrumb + close. */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground">
            {orgLogo ? (
              <img
                src={orgLogo}
                alt=""
                className="size-3.5 rounded-sm object-cover"
              />
            ) : (
              <Cube01 size={13} className="text-muted-foreground" />
            )}
            {orgName}
          </span>
          <ChevronRight size={14} className="text-muted-foreground" />
          <span className="text-sm text-muted-foreground">New task</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              reset();
              onClose();
            }}
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Prompt — the task is described like a chat message. */}
        <div className="px-4 pt-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Describe the task…"
            aria-label="Task prompt"
            autoFocus
            className="min-h-[96px] w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </div>

        {/* Footer — agent picker + create. */}
        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
              >
                <AgentAvatar
                  icon={selectedAgent.icon ?? null}
                  name={selectedAgent.title}
                  size="2xs"
                />
                {selectedAgent.title}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {agentOptions.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => setAgentId(a.id)}
                  className="gap-2"
                >
                  <AgentAvatar
                    icon={a.icon ?? null}
                    name={a.title}
                    size="2xs"
                  />
                  <span className="truncate">{a.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!prompt.trim() || creating}
            onClick={() => void submit()}
          >
            Create task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
