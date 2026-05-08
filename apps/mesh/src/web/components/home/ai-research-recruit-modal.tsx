import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  WELL_KNOWN_AGENT_TEMPLATES,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { track } from "@/web/lib/posthog-client";

const AI_RESEARCH_SYSTEM_PROMPT = `You are a systematic research assistant. You have access to web search tools and user's prompts will have somewhat relation to searching the web. Help users conduct thorough, well-structured research on any topic.

VERY IMPORTANT: The user might not have any web research model connected. If so, guide the user to use an AI Provider that has an Web Search generation, or connect a specific model in our connections.

When given a research question or topic:
- Break it down into key sub-questions and define the scope
- Gather and synthesize information from multiple angles
- Distinguish clearly between established facts, expert consensus, and contested claims
- Identify sources, patterns, gaps, and contradictions
- Deliver findings as clear, structured summaries with actionable insights

Approach every request with rigor and intellectual honesty. Always surface what is uncertain or debated, not just what is known.`;

interface AiResearchRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgent?: { id: string } | null;
}

const CAPABILITIES = [
  "Break any topic into key sub-questions and define scope",
  "Synthesize information from multiple angles and sources",
  "Distinguish facts, expert consensus, and contested claims",
  "Identify gaps, contradictions, and emerging patterns",
  "Deliver structured summaries with actionable insights",
];

function RecruitContent({
  onRecruit,
  isRecruiting,
}: {
  onRecruit: () => void;
  isRecruiting: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Add a Web Researcher agent that conducts thorough, rigorous research on
        any topic and delivers structured, actionable insights.
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Capabilities</p>
        <ul className="space-y-1.5">
          {CAPABILITIES.map((cap) => (
            <li
              key={cap}
              className="text-sm text-muted-foreground flex items-start gap-2"
            >
              <span className="text-amber-500 mt-0.5 shrink-0">+</span>
              {cap}
            </li>
          ))}
        </ul>
      </div>

      <Button
        onClick={onRecruit}
        disabled={isRecruiting}
        className="w-full cursor-pointer"
      >
        {isRecruiting ? "Setting up..." : "Add Web Researcher"}
      </Button>
    </div>
  );
}

export function AiResearchRecruitModal({
  open,
  onOpenChange,
  existingAgent,
}: AiResearchRecruitModalProps) {
  const isMobile = useIsMobile();
  const navigateToAgent = useNavigateToAgent();
  const virtualMcpActions = useVirtualMCPActions();
  const [isRecruiting, setIsRecruiting] = useState(false);

  const template = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "ai-research",
  )!;

  const headerIcon = (
    <IntegrationIcon icon={template.icon} name={template.title} size="sm" />
  );

  const handleRecruit = async () => {
    if (existingAgent) {
      onOpenChange(false);
      navigateToAgent(existingAgent.id);
      return;
    }

    setIsRecruiting(true);
    try {
      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: template.title,
        description: "Systematic research and information synthesis assistant",
        icon: template.icon,
        status: "active",
        connections: [],
        metadata: {
          type: "ai-research",
          instructions: AI_RESEARCH_SYSTEM_PROMPT,
        },
      });

      track("agent_recruit_confirmed", {
        template_id: "ai-research",
        agent_id: virtualMcp.id!,
      });
      onOpenChange(false);
      navigateToAgent(virtualMcp.id!);
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "ai-research",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to create Researcher agent:", error);
    } finally {
      setIsRecruiting(false);
    }
  };

  const title = `Add ${template.title}`;

  return isMobile ? (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[70dvh]">
        <DrawerHeader className="px-4 pt-4 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DrawerTitle className="text-xl font-semibold">{title}</DrawerTitle>
          </div>
        </DrawerHeader>
        <div className="flex flex-col flex-1 min-h-0 px-4 pb-8">
          <RecruitContent
            onRecruit={handleRecruit}
            isRecruiting={isRecruiting}
          />
        </div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-8">
        <DialogHeader className="mb-4">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
          </div>
        </DialogHeader>
        <RecruitContent onRecruit={handleRecruit} isRecruiting={isRecruiting} />
      </DialogContent>
    </Dialog>
  );
}
