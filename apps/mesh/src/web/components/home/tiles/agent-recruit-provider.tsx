/**
 * Mounts the recruit/import modals for the well-known agent templates
 * once at the home level and exposes an imperative `openRecruit` and
 * `openExisting` to the agent.card tile via context. Mirrors the
 * dispatch logic the legacy `AgentsList` used to do inline so a click
 * on, say, the Site Editor tile opens the import dialog instead of
 * navigating to a chat that has nothing to recruit.
 */

import { createContext, use, useState, type ReactNode } from "react";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCPs,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { AiImageRecruitModal } from "@/web/components/home/ai-image-recruit-modal.tsx";
import { AiResearchRecruitModal } from "@/web/components/home/ai-research-recruit-modal.tsx";
import { LeanCanvasRecruitModal } from "@/web/components/home/lean-canvas-recruit-modal.tsx";
import { StudioPackRecruitModal } from "@/web/components/home/studio-pack-recruit-modal.tsx";
import { SelfHealingRepoFlow } from "@/web/components/self-healing-repo/self-healing-repo-flow.tsx";
import { useNavigateToAgentThread } from "@/web/hooks/use-navigate-to-agent-thread";
import type { AgentSeedId } from "./agent-seeds";

type ExistingMatch = (VirtualMCPEntity & { id: string }) | undefined;

function findExistingForTemplate(
  agents: VirtualMCPEntity[],
  templateId: string,
  templateTitle: string,
): ExistingMatch {
  return agents.find(
    (a): a is typeof a & { id: string } =>
      a.id !== null &&
      !isDecopilot(a.id) &&
      ((a as { metadata?: { type?: string } }).metadata?.type === templateId ||
        a.title === templateTitle),
  );
}

interface RecruitContextValue {
  /**
   * Open the right surface for a given agent seed — either the recruit
   * modal (for templates that aren't installed yet) or a chat thread
   * with the existing matching virtual MCP.
   */
  openAgent: (templateId: AgentSeedId, title: string) => void;
}

const AgentRecruitContext = createContext<RecruitContextValue | null>(null);

export function AgentRecruitProvider({ children }: { children: ReactNode }) {
  const { org } = useProjectContext();
  const navigateToAgentThread = useNavigateToAgentThread(org.slug);
  const virtualMcps = useVirtualMCPs();

  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const [aiImageModalOpen, setAiImageModalOpen] = useState(false);
  const [aiResearchModalOpen, setAiResearchModalOpen] = useState(false);
  const [leanCanvasModalOpen, setLeanCanvasModalOpen] = useState(false);
  const [studioPackModalOpen, setStudioPackModalOpen] = useState(false);
  const [selfHealingOpen, setSelfHealingOpen] = useState(false);

  // Resolve "is this template already installed as a custom MCP" so the
  // dialog modals can pre-fill / skip create paths and the openAgent
  // dispatch can short-circuit straight into a thread.
  const existingDiagnostics = findExistingForTemplate(
    virtualMcps,
    "site-diagnostics",
    "Site Diagnostics",
  );
  const existingAiImage = findExistingForTemplate(
    virtualMcps,
    "ai-image",
    "Image Creator",
  );
  const existingAiResearch = findExistingForTemplate(
    virtualMcps,
    "ai-research",
    "Web Researcher",
  );
  const existingLeanCanvas = findExistingForTemplate(
    virtualMcps,
    "lean-canvas",
    "Lean Canvas",
  );

  const openAgent = (templateId: AgentSeedId, _title: string) => {
    switch (templateId) {
      case "site-editor":
        setImportDecoOpen(true);
        return;
      case "site-diagnostics":
        if (existingDiagnostics) {
          void navigateToAgentThread(existingDiagnostics.id);
          return;
        }
        setDiagnosticsModalOpen(true);
        return;
      case "ai-image":
        if (existingAiImage) {
          void navigateToAgentThread(existingAiImage.id);
          return;
        }
        setAiImageModalOpen(true);
        return;
      case "ai-research":
        if (existingAiResearch) {
          void navigateToAgentThread(existingAiResearch.id);
          return;
        }
        setAiResearchModalOpen(true);
        return;
      case "lean-canvas":
        if (existingLeanCanvas) {
          void navigateToAgentThread(existingLeanCanvas.id);
          return;
        }
        setLeanCanvasModalOpen(true);
        return;
      case "studio-pack":
        setStudioPackModalOpen(true);
        return;
      case "self-healing-storefront":
        setSelfHealingOpen(true);
        return;
      default: {
        const _exhaustive: never = templateId;
        return _exhaustive;
      }
    }
  };

  return (
    <AgentRecruitContext.Provider value={{ openAgent }}>
      {children}
      <ImportFromDecoDialog
        open={importDecoOpen}
        onOpenChange={setImportDecoOpen}
      />
      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
        existingAgent={existingDiagnostics}
      />
      <AiImageRecruitModal
        open={aiImageModalOpen}
        onOpenChange={setAiImageModalOpen}
        existingAgent={existingAiImage}
      />
      <AiResearchRecruitModal
        open={aiResearchModalOpen}
        onOpenChange={setAiResearchModalOpen}
        existingAgent={existingAiResearch}
      />
      <LeanCanvasRecruitModal
        open={leanCanvasModalOpen}
        onOpenChange={setLeanCanvasModalOpen}
        existingAgent={existingLeanCanvas}
      />
      <StudioPackRecruitModal
        open={studioPackModalOpen}
        onOpenChange={setStudioPackModalOpen}
      />
      <SelfHealingRepoFlow
        open={selfHealingOpen}
        onOpenChange={setSelfHealingOpen}
      />
    </AgentRecruitContext.Provider>
  );
}

export function useAgentRecruit(): RecruitContextValue | null {
  return use(AgentRecruitContext);
}
