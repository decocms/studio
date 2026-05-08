/**
 * Studio Pack Recruitment Modal
 *
 * Shown when the user clicks the Studio Pack template.
 * Creates 3 agents (Agent Manager, Automation Manager, Connection Manager)
 * connected to the org's self connection, then navigates to the org home.
 */

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
import { useProjectContext } from "@decocms/mesh-sdk";
import { STUDIO_PACK_AGENTS } from "@/tools/virtual/studio-pack";
import { useEnsureStudioPack } from "./use-ensure-studio-pack";
import { useNavigate } from "@tanstack/react-router";
import { track } from "@/web/lib/posthog-client";

interface StudioPackRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const AGENTS_SUMMARY = [
  {
    title: "Agent Manager",
    description: "Create, configure, and manage agents",
  },
  {
    title: "Automation Manager",
    description: "Create, configure, and run automations with triggers",
  },
  {
    title: "Connection Manager",
    description: "Create, configure, test, and manage connections",
  },
];

function RecruitContent({
  onInstall,
  isInstalling,
}: {
  onInstall: () => void;
  isInstalling: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Install a suite of pre-configured agents for managing your studio. Each
        agent is scoped to a specific domain with focused instructions.
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Included agents</p>
        <ul className="space-y-1.5">
          {AGENTS_SUMMARY.map((agent) => (
            <li
              key={agent.title}
              className="text-sm text-muted-foreground flex items-start gap-2"
            >
              <span className="text-emerald-500 mt-0.5 shrink-0">+</span>
              <span>
                <span className="text-foreground font-medium">
                  {agent.title}
                </span>{" "}
                — {agent.description}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Button
        onClick={onInstall}
        disabled={isInstalling}
        className="w-full cursor-pointer"
      >
        {isInstalling ? "Installing..." : "Install Studio Pack"}
      </Button>
    </div>
  );
}

export function StudioPackRecruitModal({
  open,
  onOpenChange,
}: StudioPackRecruitModalProps) {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();
  const ensure = useEnsureStudioPack();
  const navigate = useNavigate();
  const [isInstalling, setIsInstalling] = useState(false);

  const headerIcon = (
    <IntegrationIcon
      icon="icon://Package?color=blue"
      name="Studio Pack"
      size="sm"
    />
  );

  const handleInstall = async () => {
    setIsInstalling(true);
    try {
      const allTemplateIds = STUDIO_PACK_AGENTS.map((a) => a.id);
      await ensure(allTemplateIds);

      track("agent_recruit_confirmed", {
        template_id: "studio-pack",
        installed_count: allTemplateIds.length,
      });
      onOpenChange(false);
      navigate({ to: "/$org", params: { org: org.slug } });
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "studio-pack",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to install Studio Pack:", error);
    } finally {
      setIsInstalling(false);
    }
  };

  const title = "Install Studio Pack";

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
            onInstall={handleInstall}
            isInstalling={isInstalling}
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
        <RecruitContent onInstall={handleInstall} isInstalling={isInstalling} />
      </DialogContent>
    </Dialog>
  );
}
