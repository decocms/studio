/**
 * Deployment-admin agent copy: move an agent — system prompt, connections, and
 * their credentials — from one organization to another.
 *
 * Three panes, left to right, because the operation genuinely has three inputs
 * and hiding any of them behind a wizard step would cost a click without buying
 * clarity: pick the source org, pick one of its agents, pick the target org.
 * The report that comes back is the important part of the screen — a copy is
 * routinely partial (nested agents, knowledge files and org-bound settings can't
 * travel), so what did NOT come along is shown as prominently as what did.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Copy01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { Page } from "@/components/page";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { adminFetch } from "@/lib/admin-fetch";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface AdminOrg {
  id: string;
  name: string;
  slug: string;
}

interface AdminAgent {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  connectionCount: number;
  hasInstructions: boolean;
}

interface CopyResult {
  agentId: string;
  title: string;
  targetOrgId: string;
  copiedConnections: { sourceId: string; targetId: string; title: string }[];
  remappedConnections: { sourceId: string; targetId: string }[];
  copiedSecrets: number;
  copiedPrompts: number;
  skipped: string[];
}

function useOrgSearch(search: string) {
  const debounced = useDebouncedValue(search.trim(), 300);
  return useQuery({
    queryKey: KEYS.deploymentAdminOrgs(debounced),
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debounced) params.set("search", debounced);
      return adminFetch<{ organizations: AdminOrg[] }>(
        `/api/_admin/orgs?${params}`,
      );
    },
  });
}

/** A selectable row. Radio semantics: exactly one selection per pane. */
function PickerRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-foreground bg-muted"
          : "border-transparent hover:bg-muted",
      )}
    >
      {children}
      {selected ? (
        <Check size={16} className="ml-auto shrink-0 text-foreground" />
      ) : null}
    </button>
  );
}

function OrgPicker({
  label,
  selected,
  onSelect,
  excludeOrgId,
}: {
  label: string;
  selected: AdminOrg | null;
  onSelect: (org: AdminOrg) => void;
  excludeOrgId?: string;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useOrgSearch(search);
  const orgs = (data?.organizations ?? []).filter(
    (org) => org.id !== excludeOrgId,
  );

  // Each pane is a labelled region: the two org pickers are otherwise
  // indistinguishable to a screen reader (and to a test driver) since they
  // render the same rows.
  return (
    <section aria-label={label} className="flex min-h-0 flex-col gap-3">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("admin.copyAgent.searchOrgs")}
      />
      <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
        {isLoading ? (
          <div className="flex items-center justify-center p-6">
            <Spinner size="sm" />
          </div>
        ) : orgs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("admin.copyAgent.noOrgs")}
          </p>
        ) : (
          <div
            className="flex flex-col gap-1 p-1"
            role="radiogroup"
            aria-label={label}
          >
            {orgs.map((org) => (
              <PickerRow
                key={org.id}
                selected={selected?.id === org.id}
                onSelect={() => onSelect(org)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">
                    {org.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {org.slug}
                  </div>
                </div>
              </PickerRow>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function AgentPicker({
  sourceOrg,
  selected,
  onSelect,
}: {
  sourceOrg: AdminOrg | null;
  selected: AdminAgent | null;
  onSelect: (agent: AdminAgent) => void;
}) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminOrgAgents(sourceOrg?.id ?? ""),
    queryFn: () =>
      adminFetch<{ agents: AdminAgent[] }>(
        `/api/_admin/orgs/${sourceOrg!.id}/agents`,
      ),
    enabled: Boolean(sourceOrg),
  });

  const agents = data?.agents ?? [];
  const label = t("admin.copyAgent.agentStep");

  return (
    <section aria-label={label} className="flex min-h-0 flex-col gap-3">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
        {!sourceOrg ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("admin.copyAgent.pickSourceFirst")}
          </p>
        ) : isLoading ? (
          <div className="flex items-center justify-center p-6">
            <Spinner size="sm" />
          </div>
        ) : isError ? (
          <p className="p-4 text-sm text-destructive">
            {t("admin.copyAgent.failedLoadAgents")}
          </p>
        ) : agents.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("admin.copyAgent.noAgents")}
          </p>
        ) : (
          <div
            className="flex flex-col gap-1 p-1"
            role="radiogroup"
            aria-label={label}
          >
            {agents.map((agent) => (
              <PickerRow
                key={agent.id}
                selected={selected?.id === agent.id}
                onSelect={() => onSelect(agent)}
              >
                <AgentAvatar
                  icon={agent.icon}
                  name={agent.title}
                  size="sm"
                  className="shrink-0"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">
                    {agent.title}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t("admin.copyAgent.agentSummary", {
                      connections: String(agent.connectionCount),
                    })}
                    {agent.hasInstructions
                      ? ""
                      : ` · ${t("admin.copyAgent.noPrompt")}`}
                  </div>
                </div>
              </PickerRow>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function CopyReport({
  result,
  targetOrg,
}: {
  result: CopyResult;
  targetOrg: AdminOrg;
}) {
  const t = useT();
  const copiedCount = result.copiedConnections.length;

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="success">
        <Check />
        <AlertTitle>
          {t("admin.copyAgent.copiedTitle", {
            title: result.title,
            org: targetOrg.name,
          })}
        </AlertTitle>
        <AlertDescription>
          {t("admin.copyAgent.copiedSummary", {
            connections: String(copiedCount),
            reused: String(result.remappedConnections.length),
            secrets: String(result.copiedSecrets),
            prompts: String(result.copiedPrompts),
          })}
        </AlertDescription>
      </Alert>

      {copiedCount > 0 ? (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-sm font-medium">
            {t("admin.copyAgent.connectionsCopied")}
          </div>
          <ul className="divide-y divide-border">
            {result.copiedConnections.map((conn) => (
              <li
                key={conn.targetId}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <span className="truncate text-foreground">{conn.title}</span>
                <ArrowRight
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <code className="truncate text-xs text-muted-foreground">
                  {conn.targetId}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.skipped.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>
            {t("admin.copyAgent.skippedTitle", {
              count: String(result.skipped.length),
            })}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {result.skipped.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export default function AdminCopyAgentPage() {
  const t = useT();
  const [sourceOrg, setSourceOrg] = useState<AdminOrg | null>(null);
  const [agent, setAgent] = useState<AdminAgent | null>(null);
  const [targetOrg, setTargetOrg] = useState<AdminOrg | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  // Held so the report keeps naming the org it copied into even if the operator
  // starts picking a different target for the next copy.
  const [reportOrg, setReportOrg] = useState<AdminOrg | null>(null);

  const copy = useMutation({
    mutationFn: () =>
      adminFetch<CopyResult>(`/api/_admin/agents/${agent!.id}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetOrgId: targetOrg!.id }),
      }),
    onSuccess: (data) => {
      setResult(data);
      setReportOrg(targetOrg);
      toast.success(t("admin.copyAgent.copySucceeded"));
    },
    onError: (error) => {
      setResult(null);
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.copyAgent.copyFailed"),
      );
    },
  });

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <p className="max-w-3xl text-sm text-muted-foreground">
              {t("admin.copyAgent.intro")}
            </p>

            <div className="grid min-h-0 gap-6 lg:grid-cols-3">
              <div className="flex h-[420px] min-h-0 flex-col">
                <OrgPicker
                  label={t("admin.copyAgent.sourceStep")}
                  selected={sourceOrg}
                  onSelect={(org) => {
                    setSourceOrg(org);
                    setAgent(null);
                    if (targetOrg?.id === org.id) setTargetOrg(null);
                  }}
                  excludeOrgId={targetOrg?.id}
                />
              </div>
              <div className="flex h-[420px] min-h-0 flex-col">
                <AgentPicker
                  sourceOrg={sourceOrg}
                  selected={agent}
                  onSelect={setAgent}
                />
              </div>
              <div className="flex h-[420px] min-h-0 flex-col">
                <OrgPicker
                  label={t("admin.copyAgent.targetStep")}
                  selected={targetOrg}
                  onSelect={setTargetOrg}
                  excludeOrgId={sourceOrg?.id}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={() => copy.mutate()}
                disabled={!agent || !targetOrg || copy.isPending}
              >
                {copy.isPending ? <Spinner size="xs" /> : <Copy01 />}
                {agent && targetOrg
                  ? t("admin.copyAgent.copyAction", {
                      agent: agent.title,
                      org: targetOrg.name,
                    })
                  : t("admin.copyAgent.copyActionIdle")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("admin.copyAgent.credentialWarning")}
              </span>
            </div>

            {result && reportOrg ? (
              <CopyReport result={result} targetOrg={reportOrg} />
            ) : null}
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
