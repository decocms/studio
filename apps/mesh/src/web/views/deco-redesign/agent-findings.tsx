/**
 * Agent findings (mock) — agent-scope
 *
 * What the agent watches and how far it can act on its own, per capability.
 * This is agent config: it applies to everyone who has the agent. Personal
 * notification delivery lives on the user's Notifications page. Agent-aware via
 * `?agent`. Mock only.
 */

import { useState } from "react";
import {
  Activity,
  LayoutAlt01,
  SearchSm,
  ShieldTick,
  ShoppingBag03,
  Zap,
} from "@untitledui/icons";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { resolveAgent } from "./agent-data";

type Autonomy = "off" | "inform" | "propose" | "auto";

const AUTONOMY_STEPS: { value: Autonomy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "inform", label: "Inform" },
  { value: "propose", label: "Propose" },
  { value: "auto", label: "Auto" },
];

interface Capability {
  id: string;
  label: string;
  icon: typeof Activity;
  watches: string;
  defaultMode: Autonomy;
}

const CAPABILITIES: Capability[] = [
  {
    id: "system-health",
    label: "System health",
    icon: Activity,
    watches: "Errors, latency, and 5xx spikes",
    defaultMode: "propose",
  },
  {
    id: "seo",
    label: "SEO",
    icon: SearchSm,
    watches: "Canonicals, metadata, and broken links",
    defaultMode: "auto",
  },
  {
    id: "performance",
    label: "Performance",
    icon: Zap,
    watches: "Core Web Vitals and page speed",
    defaultMode: "inform",
  },
  {
    id: "qa",
    label: "QA",
    icon: ShieldTick,
    watches: "Checkout and the purchase journey",
    defaultMode: "propose",
  },
  {
    id: "plp",
    label: "PLP optimizer",
    icon: LayoutAlt01,
    watches: "Collection-page ranking and merchandising",
    defaultMode: "off",
  },
  {
    id: "pdp",
    label: "PDP optimizer",
    icon: ShoppingBag03,
    watches: "Product-page content and conversion",
    defaultMode: "off",
  },
];

function CapabilityRow({
  capability,
  mode,
  onChange,
}: {
  capability: Capability;
  mode: Autonomy;
  onChange: (next: Autonomy) => void;
}) {
  const Icon = capability.icon;
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {capability.label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {capability.watches}
          </span>
        </span>
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={mode}
        onValueChange={(value) => value && onChange(value as Autonomy)}
        className="w-full"
      >
        {AUTONOMY_STEPS.map((step) => (
          <ToggleGroupItem
            key={step.value}
            value={step.value}
            className="flex-1 text-xs"
          >
            {step.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function AgentFindings() {
  const { agent } = useSearch({ from: "/shell/$org/settings/agent/findings" });
  const { org: organization } = useProjectContext();
  const profile = resolveAgent(agent, {
    name: organization.name,
    logo: organization.logo,
  });

  const [modes, setModes] = useState<Record<string, Autonomy>>(() =>
    Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.defaultMode])),
  );

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div>
              <h1 className="text-xl font-medium text-foreground">Findings</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                What {profile.name} watches and how far it can act. Applies to
                everyone.
              </p>
            </div>

            <SettingsSection title="Autonomy">
              <SettingsCard>
                {CAPABILITIES.map((c) => (
                  <CapabilityRow
                    key={c.id}
                    capability={c}
                    mode={modes[c.id] ?? c.defaultMode}
                    onChange={(next) =>
                      setModes((prev) => ({ ...prev, [c.id]: next }))
                    }
                  />
                ))}
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
