/**
 * Agent automations (mock)
 *
 * Automation is a Studio primitive (the scheduler/trigger engine), surfaced
 * here split by origin:
 *   • System — provisioned by a capability when it's enabled. Managed,
 *     view-only, labelled "from <capability>". The user never hand-writes these.
 *   • Yours  — explicit recurring work the user created.
 *
 * Same engine, two authors — like skills (included vs your own). Agent-aware via
 * `?agent`. Mock only.
 */

import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { Lock01, Plus, Zap } from "@untitledui/icons";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { resolveAgent } from "./agent-data";

interface SystemAutomation {
  id: string;
  name: string;
  capability: string;
  when: string;
}

const SYSTEM: SystemAutomation[] = [
  {
    id: "error-watch",
    name: "Error watch",
    capability: "System health",
    when: "When 5xx spikes",
  },
  {
    id: "seo-sweep",
    name: "SEO sweep",
    capability: "SEO",
    when: "Mondays at 06:00",
  },
  {
    id: "cache-research",
    name: "Cache research",
    capability: "Performance",
    when: "Nightly",
  },
  {
    id: "checkout-qa",
    name: "Checkout QA",
    capability: "QA",
    when: "On every deploy",
  },
];

interface UserAutomation {
  id: string;
  name: string;
  when: string;
  enabled: boolean;
}

const INITIAL_YOURS: UserAutomation[] = [
  {
    id: "traffic-email",
    name: "Weekly traffic email",
    when: "Mondays at 09:00",
    enabled: true,
  },
];

function AutomationIcon() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
      <Zap size={16} />
    </span>
  );
}

export function AgentAutomations() {
  const { agent } = useSearch({
    from: "/shell/$org/settings/agent/automations",
  });
  const { org: organization } = useProjectContext();
  const profile = resolveAgent(agent, {
    name: organization.name,
    logo: organization.logo,
  });
  const [yours, setYours] = useState<UserAutomation[]>(INITIAL_YOURS);

  const toggle = (id: string, enabled: boolean) =>
    setYours((prev) => prev.map((a) => (a.id === id ? { ...a, enabled } : a)));

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div>
              <h1 className="text-xl font-medium text-foreground">
                Automations
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Recurring work {profile.name} runs. Capabilities bring their
                own; add your own below.
              </p>
            </div>

            {/* System — provisioned by capabilities */}
            <SettingsSection title="System">
              <SettingsCard>
                {SYSTEM.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                    <AutomationIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {a.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        from {a.capability} · {a.when}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      <Lock01 size={10} />
                      Managed by Deco
                    </span>
                  </div>
                ))}
              </SettingsCard>
            </SettingsSection>

            {/* Yours — explicit recurring work */}
            <SettingsSection title="Yours">
              <SettingsCard>
                {yours.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                    <AutomationIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {a.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.when}
                      </span>
                    </span>
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={(v) => toggle(a.id, v)}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground/75">
                    <Plus size={16} />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    New automation
                  </span>
                </button>
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
