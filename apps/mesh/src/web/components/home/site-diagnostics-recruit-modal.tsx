/**
 * Site Diagnostics Recruitment Modal
 *
 * Shown when the user clicks the Site Diagnostics agent on the home page.
 * Creates the agent as a real virtual MCP and navigates to it with chat open.
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
import { useNavigate } from "@tanstack/react-router";
import {
  SITE_DIAGNOSTICS_DESCRIPTION,
  SITE_DIAGNOSTICS_ICON,
  SITE_DIAGNOSTICS_INSTRUCTIONS,
  WellKnownOrgMCPId,
  useProjectContext,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";

interface SiteDiagnosticsRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CAPABILITIES = [
  "Full HAR capture with cache, TTFB, and request analysis",
  "Screenshot capture for visual inspection",
  "Page discovery via sitemap, navigation, and link crawling",
  "SEO audit — meta tags, structured data, robots.txt",
  "Third-party script inventory and size analysis",
  "Dead link detection across the entire site",
  "Deco-specific diagnostics (?__d debug mode)",
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
        Add a blackbox diagnostics agent that tests your storefront from the
        outside — no internal access needed. Give it a URL and it produces a
        detailed performance and health report.
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Capabilities</p>
        <ul className="space-y-1.5">
          {CAPABILITIES.map((cap) => (
            <li
              key={cap}
              className="text-sm text-muted-foreground flex items-start gap-2"
            >
              <span className="text-emerald-500 mt-0.5 shrink-0">+</span>
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
        {isRecruiting ? "Setting up..." : "Add Site Diagnostics"}
      </Button>
    </div>
  );
}

const HEADER_ICON = (
  <IntegrationIcon
    icon={SITE_DIAGNOSTICS_ICON}
    name="Site Diagnostics"
    size="sm"
  />
);

export function SiteDiagnosticsRecruitModal({
  open,
  onOpenChange,
}: SiteDiagnosticsRecruitModalProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const [isRecruiting, setIsRecruiting] = useState(false);

  const handleRecruit = async () => {
    setIsRecruiting(true);
    try {
      // Include the self MCP connection so Claude Code (and other providers)
      // can discover diagnostics tools (capture_har, screenshot, fetch_page)
      const selfConnectionId = WellKnownOrgMCPId.SELF(org.id);

      const virtualMcp = await actions.create.mutateAsync({
        title: "Site Diagnostics",
        description: SITE_DIAGNOSTICS_DESCRIPTION,
        icon: SITE_DIAGNOSTICS_ICON,
        status: "active",
        connections: [
          {
            connection_id: selfConnectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          type: "site-diagnostics",
          instructions: SITE_DIAGNOSTICS_INSTRUCTIONS,
        },
      });

      onOpenChange(false);
      navigate({
        to: "/$org/$virtualMcpId",
        params: {
          org: org.slug,
          virtualMcpId: virtualMcp.id!,
        },
      });
    } catch (error) {
      console.error("Failed to create Site Diagnostics agent:", error);
    } finally {
      setIsRecruiting(false);
    }
  };

  const title = "Add Site Diagnostics";

  return isMobile ? (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[70dvh]">
        <DrawerHeader className="px-4 pt-4 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            {HEADER_ICON}
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
            {HEADER_ICON}
            <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
          </div>
        </DialogHeader>
        <RecruitContent onRecruit={handleRecruit} isRecruiting={isRecruiting} />
      </DialogContent>
    </Dialog>
  );
}
