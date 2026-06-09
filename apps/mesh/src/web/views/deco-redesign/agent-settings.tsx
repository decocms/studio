/**
 * Agent settings (mock) — the agent's home page
 *
 * The main page is the agent's DEFINITION (managed by Deco, view-only):
 * Prompt · Memory · Files · Automations. The editable user layer lives behind a
 * single "Agent personalization" item that opens its own page.
 *
 * Agent-aware: `?agent` selects which of the user's agents to show (current
 * org by default). Mock only.
 */

import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  Bell01,
  ChevronRight,
  Database01,
  File02,
  FileCode01,
  Lock01,
  Settings04,
  Zap,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Button } from "@deco/ui/components/button.tsx";
import { resolveAgent } from "./agent-data";

const AGENT_REPO_URL = "https://github.com/decocms/studio";

interface DefinitionRow {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  to?: string;
  href?: string;
  managed?: boolean;
}

const DEFINITION: DefinitionRow[] = [
  {
    key: "prompt",
    label: "Prompt",
    description: "Role, goals, constraints, and voice",
    icon: <FileCode01 size={16} />,
    path: "AGENTS.md",
    href: `${AGENT_REPO_URL}/blob/main/AGENTS.md`,
    managed: true,
  },
  {
    key: "memory",
    label: "Memory",
    description: "What the agent remembers about you and the work",
    icon: <Database01 size={16} />,
    path: "memory.json",
    to: "/$org/settings/agent/memory",
  },
  {
    key: "files",
    label: "Files",
    description: "Documents the agent reads, and the files it produces",
    icon: <File02 size={16} />,
    path: "files/",
    to: "/$org/settings/agent/files",
  },
  {
    key: "automations",
    label: "Automations",
    description: "Recurring work the agent runs on a schedule",
    icon: <Zap size={16} />,
    path: "automations/",
    to: "/$org/settings/agent/automations",
  },
];

function ManagedPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Lock01 size={10} />
      Managed by Deco
    </span>
  );
}

function RowBody({
  icon,
  label,
  description,
  managed,
  path,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  managed?: boolean;
  path?: string;
}) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      {managed && <ManagedPill />}
      {path && (
        <code className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">
          {path}
        </code>
      )}
      <ChevronRight size={16} className="shrink-0 text-muted-foreground/50" />
    </>
  );
}

export function AgentSettings() {
  const { org } = useParams({ from: "/shell/$org" });
  const { agent } = useSearch({ from: "/shell/$org/settings/agent" });
  const { org: organization } = useProjectContext();
  const profile = resolveAgent(agent, {
    name: organization.name,
    logo: organization.logo,
  });

  const initial = profile.name?.[0]?.toUpperCase() ?? "A";
  const rowClass =
    "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50";

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            {/* Identity header */}
            <div className="flex items-center gap-3">
              {profile.logo ? (
                <img
                  src={profile.logo}
                  alt=""
                  className="size-12 shrink-0 rounded-xl border border-border object-cover"
                />
              ) : (
                <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-foreground/10 text-lg font-semibold text-foreground">
                  {initial}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-medium leading-tight text-foreground">
                  {profile.name}
                </h1>
                <p className="truncate text-sm text-muted-foreground">
                  {profile.blurb}
                </p>
              </div>
              <a
                href={AGENT_REPO_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="View agent repository on GitHub"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-foreground transition-colors hover:bg-muted"
              >
                <GitHubIcon size={16} />
              </a>
              <Button variant="outline" size="sm" className="shrink-0">
                Connect
              </Button>
            </div>

            {/* Managed banner */}
            <div className="-mt-4 flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3">
              <Lock01
                size={15}
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
              <p className="text-sm leading-relaxed text-muted-foreground">
                Built and maintained by Deco. Its definition is view-only — make
                it yours in Agent personalization.
              </p>
            </div>

            {/* Configurable entries — your layer + the team-wide finding rules */}
            <SettingsSection>
              <SettingsCard>
                <Link
                  to="/$org/settings/agent/personalization"
                  params={{ org }}
                  search={{ agent }}
                  className={rowClass}
                >
                  <RowBody
                    icon={<Settings04 size={16} />}
                    label="Agent personalization"
                    description="Your guidance, skills, and connections"
                  />
                </Link>
                <Link
                  to="/$org/settings/agent/findings"
                  params={{ org }}
                  search={{ agent }}
                  className={rowClass}
                >
                  <RowBody
                    icon={<Bell01 size={16} />}
                    label="Findings"
                    description="What this agent watches and how far it can act"
                  />
                </Link>
              </SettingsCard>
            </SettingsSection>

            {/* Definition — managed by Deco, view-only */}
            <SettingsSection
              title="Definition"
              description="The agent's source and data. Managed by Deco — view-only."
            >
              <SettingsCard>
                {DEFINITION.map((row) =>
                  row.href ? (
                    <a
                      key={row.key}
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className={rowClass}
                    >
                      <RowBody {...row} />
                    </a>
                  ) : (
                    <Link
                      key={row.key}
                      to={row.to as string}
                      params={{ org }}
                      search={{ agent }}
                      className={rowClass}
                    >
                      <RowBody {...row} />
                    </Link>
                  ),
                )}
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
