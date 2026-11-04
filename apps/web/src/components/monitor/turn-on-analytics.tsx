/** Turning Deco Analytics on, step by step: who adds the tag, the site's details, then the tag and a live check. */

import { createContext, type ReactNode, useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle,
  Code02,
  Plus,
  Stars02,
  XClose,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { ListRow } from "@decocms/ui/components/list-row.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@decocms/ui/components/radio-group.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { IntegrationIcon } from "@/components/integration-icon";
import { useInstallAnalytics } from "@/hooks/use-install-analytics";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useClockTick } from "@/lib/use-clock-tick";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import {
  type AnalyticsRegisterResult,
  type AnalyticsStatus,
  CopyButton,
  DEFAULT_MODULES,
  useRegisterAnalytics,
} from "@/layouts/main-panel-tabs/analytics-tab";
import { LivePayload } from "./analytics/realtime";
import { EMPTY_SEGMENT, useDecoView } from "./analytics/segment";
import { AnalyticsPreview, Locked, useInstallableProjects } from "./locked";
import { connectLink } from "./parts";
import type { SiteProject } from "./org-insights";

const COLLECTOR = "https://analytics.decocdn.com";
const PURCHASE =
  "window.__dq?.purchase({ value, currency, transactionId, itemIds })";

type Step = "how" | "setup" | "install";
type How = "agent" | "manual";

/** The tag the site loads: the collector's own when it came back, else the one its registration implies. */
function tagFor(result: AnalyticsRegisterResult): string {
  if (result.snippet) return result.snippet;
  return result.key
    ? `<script async src="${COLLECTOR}/_dq/a.js?k=${result.key}"></script>`
    : `<script async src="/_dq/a.js"></script>`;
}

/** No analytics for the site yet: the connect card, with Deco Analytics to turn on when the site can. */
export function AnalyticsEmpty({ onTurnOn }: { onTurnOn?: () => void }) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <Locked
      kind="analytics"
      title={t("monitor.audience.empty.title")}
      link={connectLink(org.slug, null)}
      guide={
        <div>
          <ListRow
            variant="divided"
            lead={
              <IntegrationIcon
                icon="/logos/deco%20logo.svg"
                name={t("monitor.audience.source.decoAnalytics")}
                size="xs"
                fit="contain"
              />
            }
            title={t("monitor.audience.source.decoAnalytics")}
            meta={t("monitor.turnOn.powers")}
            trailing={
              onTurnOn && (
                <Button
                  size="sm"
                  className="gap-1 shadow-sm"
                  onClick={onTurnOn}
                >
                  <Plus size={14} />
                  {t("monitor.turnOn.turnOn")}
                </Button>
              )
            }
          />
        </div>
      }
    >
      <AnalyticsPreview />
    </Locked>
  );
}

/** On a site already reporting elsewhere: what Deco Analytics adds, one row with the way to turn it on. */
export function TurnOnCard({ onTurnOn }: { onTurnOn: () => void }) {
  const t = useT();
  return (
    <div className="surface px-4 py-1">
      <ListRow
        variant="divided"
        lead={
          <IntegrationIcon
            icon="/logos/deco%20logo.svg"
            name={t("monitor.audience.source.decoAnalytics")}
            size="xs"
            fit="contain"
          />
        }
        title={t("monitor.audience.source.decoAnalytics")}
        meta={t("monitor.turnOn.upgrade")}
        trailing={
          <Button size="sm" className="gap-1 shadow-sm" onClick={onTurnOn}>
            <Plus size={14} />
            {t("monitor.turnOn.turnOn")}
          </Button>
        }
      />
    </div>
  );
}

export function TurnOnAnalytics({
  orgSlug,
  project,
  status,
  open,
  onOpenChange,
  review = false,
}: {
  orgSlug: string;
  project: SiteProject;
  status: AnalyticsStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The site is registered already: straight from who adds the tag to the tag. */
  review?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Wizard
          orgSlug={orgSlug}
          project={project}
          status={status}
          review={review}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function Wizard({
  orgSlug,
  project,
  status,
  review,
  onClose,
}: {
  orgSlug: string;
  project: SiteProject;
  status: AnalyticsStatus;
  review: boolean;
  onClose: () => void;
}) {
  const installable = useInstallableProjects([project]);
  const canAgent = (installable?.length ?? 0) > 0;
  const [, setVerifying] = useVerifying(project.site);
  const [step, setStep] = useState<Step>("how");
  const [how, setHow] = useState<How | null>(null);
  // A registered site's tag comes from its status; a new one's from registering.
  const [result, setResult] = useState<AnalyticsRegisterResult | null>(
    review ? { key: status.key ?? null } : null,
  );
  const chosen = how ?? (canAgent ? "agent" : "manual");
  // Once the tag is on its way, the Analytics page watches for the first visit.
  const finish = () => {
    setVerifying(Date.now());
    onClose();
  };

  return (
    <StepsContext.Provider value={review ? REVIEW_STEPS : STEPS}>
      <div data-step={step} className="relative flex flex-col gap-6">
        {step === "how" && (
          <HowStep
            project={project}
            canAgent={canAgent}
            how={chosen}
            onHow={setHow}
            onManual={() => setStep(review ? "install" : "setup")}
            onClose={onClose}
            onSent={finish}
          />
        )}
        {step === "setup" && (
          <SetupStep
            orgSlug={orgSlug}
            project={project}
            host={status.host ?? null}
            onBack={() => setStep("how")}
            onRegistered={(r) => {
              setResult(r);
              setStep("install");
            }}
          />
        )}
        {step === "install" && result && (
          <InstallStep
            project={project}
            result={result}
            canAgent={canAgent}
            onDone={finish}
          />
        )}
      </div>
    </StepsContext.Provider>
  );
}

const STEPS: readonly Step[] = ["how", "setup", "install"];
const REVIEW_STEPS: readonly Step[] = ["how", "install"];
const StepsContext = createContext<readonly Step[]>(STEPS);

function Dots({ step }: { step: Step }) {
  const steps = useContext(StepsContext);
  const at = steps.indexOf(step);
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {steps.map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none",
            i === at ? "w-5 bg-foreground" : "w-1.5",
            i < at && "bg-foreground/40",
            i > at && "bg-foreground/15",
          )}
        />
      ))}
    </div>
  );
}

function Footer({ step, children }: { step: Step; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <Dots step={step} />
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** One of the two ways in, as a card you pick. */
function Choice({
  value,
  disabled = false,
  icon,
  title,
  badge,
  description,
}: {
  value: How;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  badge?: string;
  description?: string;
}) {
  const id = `turn-on-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "surface flex items-center gap-3.5 p-4",
        disabled ? "opacity-50" : "surface-interactive cursor-pointer",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {badge && <Badge variant="outline">{badge}</Badge>}
        </span>
        {description && <span className="text-meta">{description}</span>}
      </span>
      <RadioGroupItem id={id} value={value} disabled={disabled} />
    </label>
  );
}

function HowStep({
  project,
  canAgent,
  how,
  onHow,
  onManual,
  onClose,
  onSent,
}: {
  project: SiteProject;
  canAgent: boolean;
  how: How;
  onHow: (how: How) => void;
  onManual: () => void;
  onClose: () => void;
  /** The agent has the task: the dialog closes and the page starts checking. */
  onSent: () => void;
}) {
  const t = useT();
  const install = useInstallAnalytics();
  const [needsDomain, setNeedsDomain] = useState(false);
  const [domain, setDomain] = useState("");
  const sendToAgent = () =>
    install.mutate(
      { site: project.site, ...(needsDomain ? { domain: domain.trim() } : {}) },
      {
        onSuccess: (r) => {
          if (r.status === "needs_domain") setNeedsDomain(true);
          else onSent();
        },
      },
    );
  return (
    <>
      <DialogHeader className="gap-4">
        <span className="surface flex size-11 items-center justify-center">
          <img
            src="/logos/deco%20logo.svg"
            alt=""
            className="size-6 object-contain dark:rounded-sm dark:bg-white dark:p-0.5"
          />
        </span>
        <DialogTitle>{t("monitor.audience.activate")}</DialogTitle>
      </DialogHeader>
      <RadioGroup
        value={how}
        onValueChange={(v) => onHow(v === "agent" ? "agent" : "manual")}
        className="gap-2"
      >
        <Choice
          value="agent"
          disabled={!canAgent}
          icon={<Stars02 size={18} />}
          title={t("monitor.turnOn.agent")}
          badge={canAgent ? t("monitor.turnOn.recommended") : undefined}
          description={
            canAgent ? undefined : t("monitor.turnOn.agentNeedsRepo")
          }
        />
        <Choice
          value="manual"
          icon={<Code02 size={18} />}
          title={t("monitor.turnOn.manual")}
        />
      </RadioGroup>
      {how === "agent" && needsDomain && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="turn-on-domain">
            {t("monitor.turnOn.domainLabel")}
          </Label>
          <Input
            id="turn-on-domain"
            autoFocus
            inputMode="url"
            placeholder="www.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
      )}
      <Footer step="how">
        <Button variant="outline" onClick={onClose}>
          {t("mainPanelTabs.analyticsTab.cancel")}
        </Button>
        {how === "agent" ? (
          <Button
            onClick={sendToAgent}
            disabled={install.isPending || (needsDomain && !domain.trim())}
          >
            {install.isPending
              ? t("monitor.turnOn.starting")
              : t("monitor.turnOn.openPr")}
          </Button>
        ) : (
          <Button onClick={onManual}>{t("monitor.turnOn.continue")}</Button>
        )}
      </Footer>
    </>
  );
}

function SetupStep({
  orgSlug,
  project,
  host,
  onBack,
  onRegistered,
}: {
  orgSlug: string;
  project: SiteProject;
  host: string | null;
  onBack: () => void;
  onRegistered: (result: AnalyticsRegisterResult) => void;
}) {
  const t = useT();
  const base = `/api/${orgSlug}/hosting/${encodeURIComponent(project.site)}`;
  const register = useRegisterAnalytics(base, orgSlug, project.site);
  const queryClient = useQueryClient();
  // A site hosting knows a domain for is on deco's CDN; any other gets a token.
  const [elsewhere, setElsewhere] = useState(!host);
  const [domain, setDomain] = useState(host ?? "");

  const domains = domain
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const ready = elsewhere ? domains.length > 0 : !!host || !!domain.trim();
  // Deco decides what is collected.
  const modules = [...DEFAULT_MODULES];
  const submit = () =>
    register.mutate(
      elsewhere
        ? { key: true, domains, modules }
        : {
            modules,
            ...(host ? {} : { host: domain.trim() }),
          },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({
            queryKey: KEYS.monitorAudienceSite(orgSlug, project.site),
          });
          onRegistered(result);
        },
      },
    );
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("monitor.turnOn.setupTitle")}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label>{t("mainPanelTabs.analyticsTab.whereLabel")}</Label>
          <ToggleGroup
            type="single"
            variant="segmented"
            value={elsewhere ? "elsewhere" : "cdn"}
            onValueChange={(v) => {
              if (v) setElsewhere(v === "elsewhere");
            }}
          >
            <ToggleGroupItem value="cdn">
              {t("mainPanelTabs.analyticsTab.whereCdn")}
            </ToggleGroupItem>
            <ToggleGroupItem value="elsewhere">
              {t("mainPanelTabs.analyticsTab.whereElsewhere")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {!elsewhere && host ? (
          <div className="flex flex-col gap-1.5">
            <Label>{t("mainPanelTabs.analyticsTab.hostLabel")}</Label>
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              {host}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="turn-on-host">
              {elsewhere
                ? t("mainPanelTabs.analyticsTab.domainsLabel")
                : t("mainPanelTabs.analyticsTab.hostLabel")}
            </Label>
            <Input
              id="turn-on-host"
              inputMode="url"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={
                elsewhere
                  ? t("mainPanelTabs.analyticsTab.domainsPlaceholder")
                  : t("mainPanelTabs.analyticsTab.hostPlaceholder")
              }
            />
          </div>
        )}
      </div>

      <Footer step="setup">
        <Button variant="outline" onClick={onBack}>
          {t("monitor.turnOn.back")}
        </Button>
        <Button onClick={submit} disabled={!ready || register.isPending}>
          {register.isPending
            ? t("monitor.turnOn.turningOn")
            : t("monitor.turnOn.turnOn")}
        </Button>
      </Footer>
    </>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="surface flex items-start gap-2 py-1.5 pr-1.5 pl-3.5">
      <code className="min-w-0 flex-1 break-all py-1.5 font-mono text-xs text-foreground">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

function InstallItem({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="tnum flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-purple-tint text-xs font-medium text-brand-purple-dark dark:bg-brand-purple/20 dark:text-brand-purple">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {aside && <span className="text-meta font-normal">{aside}</span>}
        </p>
        {children}
      </div>
    </li>
  );
}

function InstallStep({
  project,
  result,
  canAgent,
  onDone,
}: {
  project: SiteProject;
  result: AnalyticsRegisterResult;
  canAgent: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const install = useInstallAnalytics();
  const keyed = !!result.key;
  const notes = result.notes ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("monitor.turnOn.installTitle")}</DialogTitle>
      </DialogHeader>

      <ol className="flex flex-col gap-5">
        <InstallItem n={1} title={t("monitor.turnOn.pasteTitle")}>
          <Code text={tagFor(result)} />
          {keyed && (
            <p className="text-meta">{t("monitor.turnOn.tokenOnce")}</p>
          )}
        </InstallItem>
        {keyed && (
          <InstallItem n={2} title={t("monitor.turnOn.cspTitle")}>
            <p className="text-meta">
              {t("monitor.turnOn.cspHint", { origin: `${COLLECTOR}/_dq/` })}
            </p>
          </InstallItem>
        )}
        <InstallItem
          n={keyed ? 3 : 2}
          title={t("monitor.turnOn.purchaseTitle")}
          aside={t("monitor.turnOn.optional")}
        >
          <Code text={PURCHASE} />
        </InstallItem>
      </ol>

      {notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note) => (
            <li
              key={note}
              className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              {note}
            </li>
          ))}
        </ul>
      )}

      <Footer step="install">
        {canAgent && (
          <Button
            variant="ghost"
            disabled={install.isPending}
            onClick={() =>
              install.mutate({ site: project.site }, { onSuccess: onDone })
            }
          >
            {install.isPending
              ? t("monitor.turnOn.starting")
              : t("monitor.turnOn.agentInstead")}
          </Button>
        )}
        <Button onClick={onDone}>{t("monitor.turnOn.done")}</Button>
      </Footer>
    </>
  );
}

/** How long a fresh install may stay silent before the check asks for a review. */
const VERIFY_FOR_MS = 30 * 60_000;

/** When the tag went on its way, per site; null once the check is over. */
function useVerifying(site: string) {
  return useLocalStorage<number | null>(
    `monitor:analytics-verify:${site}`,
    null,
  );
}

/** After an install, watches the live view for the first visit; quiet once it is over or dismissed. */
export function InstallCheck({
  orgSlug,
  site,
  onReview,
}: {
  orgSlug: string;
  site: string;
  onReview: () => void;
}) {
  const t = useT();
  const [since, setSince] = useVerifying(site);
  const live = useDecoView({
    orgSlug,
    site,
    view: "live",
    range: "5m",
    segment: EMPTY_SEGMENT,
    enabled: since !== null,
  });
  const now = useClockTick();
  if (since === null) return null;
  const headline = LivePayload.parse(live.data?.data ?? {}).liveVisitors[0];
  const counted = !!headline?.last_event || (headline?.visitors ?? 0) > 0;
  const late = !counted && now - since > VERIFY_FOR_MS;
  const state = counted ? "counted" : late ? "late" : "checking";
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3.5",
        state === "late" ? "rounded-xl bg-warning/10 shadow-edge" : "surface",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center pt-0.5">
        {state === "counted" ? (
          <CheckCircle size={18} className="text-success" />
        ) : state === "late" ? (
          <AlertTriangle size={18} className="text-warning" />
        ) : (
          <Spinner className="size-4 text-brand-purple" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {t(`monitor.installCheck.${state}.title`)}
        </span>
        <span className="text-meta">
          {t(`monitor.installCheck.${state}.description`)}
        </span>
      </span>
      {state === "late" && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={onReview}
        >
          {t("monitor.installCheck.review")}
        </Button>
      )}
      <IconButton
        label={t("monitor.installCheck.dismiss")}
        className="shrink-0"
        onClick={() => setSince(null)}
      >
        <XClose />
      </IconButton>
    </div>
  );
}
