/**
 * OnboardingMessages
 *
 * Mocked onboarding transcript rendered inside Chat.Main.
 * State machine: recommend → proposed → approved.
 * No interview questions — goes straight to agent recommendation.
 */

import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { MemoizedMarkdown } from "./markdown.tsx";
import { HireAgentModal } from "@/web/components/onboarding/hire-agent-modal.tsx";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  File06,
} from "@untitledui/icons";

// ─── Types ────────────────────────────────────────────────────────────────────

type Stage = "recommend" | "proposed" | "approved";

interface BlogTask {
  id: string;
  title: string;
  keyword: string;
  volume: string;
  competition: "low" | "medium" | "high";
}

// ─── Static data ──────────────────────────────────────────────────────────────

const BLOG_TASKS: BlogTask[] = [
  {
    id: "bp-1",
    title: "Best smart home accessories under $50",
    keyword: "best smart home accessories under $50",
    volume: "18K/mo",
    competition: "low",
  },
  {
    id: "bp-2",
    title: "How to set up a smart home in 2026",
    keyword: "how to set up a smart home",
    volume: "41K/mo",
    competition: "medium",
  },
  {
    id: "bp-3",
    title: "VTEX vs Shopify for DTC brands",
    keyword: "vtex vs shopify dtc brands",
    volume: "6K/mo",
    competition: "high",
  },
];

const ALREADY_KNOWS = [
  "Brand colors & visual identity",
  "Tech stack (Shopify Plus)",
  "~4.8M monthly visitors",
  "Top 3 competitors identified",
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function AssistantRow({ content }: { content: string }) {
  return (
    <div className="w-full min-w-0 group relative flex items-start z-20 text-foreground flex-row px-4">
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="w-full min-w-0 text-[15px] bg-transparent">
          <MemoizedMarkdown id={content.slice(0, 12)} text={content} />
        </div>
      </div>
    </div>
  );
}

function DiagnosticCard({ domain }: { domain: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mx-4 rounded-2xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <img
            src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
            className="size-4 rounded-sm"
            alt=""
          />
          <span className="text-sm font-medium text-foreground">
            Diagnostic: {domain}
          </span>
          <span className="text-xs text-muted-foreground">
            · 3 issues found
          </span>
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-4 flex flex-col gap-4">
          {/* Performance */}
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
              Performance
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                { label: "LCP", value: "4.2s", status: "Poor" },
                { label: "CLS", value: "0.12", status: "Needs improvement" },
                { label: "Mobile", value: "42/100", status: "Poor" },
              ].map((m) => (
                <div key={m.label} className="flex items-center gap-2">
                  <span className="w-12 text-xs font-medium text-foreground">
                    {m.label}
                  </span>
                  <span className="text-xs font-semibold text-red-500">
                    {m.value}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* SEO */}
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
              SEO
            </p>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-amber-500">
                  67%
                </span>
                <span className="text-xs text-muted-foreground">
                  meta descriptions missing
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">
                  1,240
                </span>
                <span className="text-xs text-muted-foreground">backlinks</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">
                  ~1.1M
                </span>
                <span className="text-xs text-muted-foreground">
                  organic visits/mo
                </span>
              </div>
            </div>
          </div>

          {/* Tech stack */}
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
              Tech Stack
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                "Shopify Plus",
                "Klaviyo",
                "Gorgias",
                "Google Ads",
                "Meta Pixel",
                "Hotjar",
              ].map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRecommendationCard({
  domain,
  onHire,
}: {
  domain: string;
  onHire: () => void;
}) {
  return (
    <div className="mx-4 rounded-2xl border border-border bg-card p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center size-12 rounded-2xl bg-violet-100 text-violet-600 shrink-0">
          <File06 size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-foreground">
            Blog Post Generator
          </p>
          <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
            Researches, writes and publishes SEO-optimised blog posts for your
            store on autopilot.
          </p>
        </div>
      </div>

      {/* Already knows chips */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Already knows about {domain}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ALREADY_KNOWS.map((fact) => (
            <span
              key={fact}
              className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs text-emerald-700"
            >
              <Check size={10} />
              {fact}
            </span>
          ))}
        </div>
      </div>

      {/* CTA */}
      <Button onClick={onHire} className="w-full">
        Hire Blog Post Generator
        <ArrowRight size={14} />
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        Looking for something else?{" "}
        <span className="underline underline-offset-2 cursor-pointer">
          Browse agent store →
        </span>
      </p>
    </div>
  );
}

function CompetitionBadge({ level }: { level: "low" | "medium" | "high" }) {
  const styles = {
    low: "bg-emerald-50 text-emerald-700 border-emerald-200",
    medium: "bg-amber-50 text-amber-700 border-amber-200",
    high: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${styles[level]}`}
    >
      {level}
    </span>
  );
}

function TaskProposalCards({
  onApprove,
}: {
  onApprove: (task: BlogTask) => void;
}) {
  return (
    <div className="flex flex-col gap-2 mx-4">
      {BLOG_TASKS.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => onApprove(task)}
          className="flex items-start gap-4 rounded-2xl border border-border bg-card px-4 py-3.5 text-left hover:bg-muted/20 transition-colors group"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-foreground">
                {task.title}
              </p>
              <CompetitionBadge level={task.competition} />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground font-mono">
                {task.keyword}
              </span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs font-medium text-foreground">
                {task.volume}
              </span>
            </div>
          </div>
          <ArrowRight
            size={14}
            className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0 mt-1"
          />
        </button>
      ))}
    </div>
  );
}

function DoneState({ orgName }: { orgName: string }) {
  const navigate = useNavigate();

  return (
    <div className="mx-4 flex flex-col gap-3">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 flex items-start gap-3">
        <div className="shrink-0 flex items-center justify-center size-8 rounded-full bg-emerald-100 text-emerald-600 mt-0.5">
          <Check size={16} />
        </div>
        <div>
          <p className="text-sm font-semibold text-emerald-800">
            Blog Post Generator hired successfully
          </p>
          <p className="text-xs text-emerald-700 mt-0.5">
            Your first draft is being written now. You&apos;ll find it in the
            Blog workspace.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          className="flex-1"
          onClick={() => {
            navigate({
              to: "/$org/$project/blog",
              params: { org: orgName, project: "storefront" },
            });
          }}
        >
          Go to Blog workspace
          <ArrowRight size={14} />
        </Button>
        <Button variant="outline" className="flex-1">
          Invite your team
        </Button>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface OnboardingMessagesProps {
  orgName: string;
  onComplete: () => void;
}

export function OnboardingMessages({ orgName }: OnboardingMessagesProps) {
  const domain = orgName.replace(/-/g, ".").toLowerCase();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>("recommend");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const welcomeText = `I've analyzed **${domain}** and found a few things worth addressing — including a slow LCP on mobile (4.2s), 67% of product pages missing meta descriptions, and real SEO opportunities in the content gap.\n\nBased on this, I have a recommendation.`;

  function handleHire() {
    localStorage.setItem("mesh_blog_hired", "true");
    window.dispatchEvent(new Event("mesh_blog_hired"));
    setStage("proposed");
  }

  function handleApprove(task: BlogTask) {
    setStage("approved");
    setTimeout(() => {
      navigate({
        to: "/$org/$project/blog",
        params: { org: orgName, project: "storefront" },
        search: { taskId: task.id },
      });
    }, 1200);
  }

  return (
    <>
      <div className="flex flex-col min-h-full max-w-2xl mx-auto w-full py-8 gap-6">
        {/* Welcome message */}
        <AssistantRow content={welcomeText} />

        {/* Diagnostic card — always visible */}
        <DiagnosticCard domain={domain} />

        {/* Stage: recommend — show agent card */}
        {stage === "recommend" && (
          <AgentRecommendationCard
            domain={domain}
            onHire={() => setDrawerOpen(true)}
          />
        )}

        {/* Stage: proposed — show task proposals */}
        {stage === "proposed" && (
          <>
            <AssistantRow content="Blog Post Generator is ready. Here are the top content opportunities it identified for your store — click one to kick off the first draft:" />
            <TaskProposalCards onApprove={handleApprove} />
          </>
        )}

        {/* Stage: approved — writing + done state */}
        {stage === "approved" && (
          <>
            <AssistantRow content="Writing your first draft now..." />
            <DoneState orgName={orgName} />
          </>
        )}

        {/* Spacer */}
        <div className="h-8" />
      </div>

      {/* Modal — rendered outside scroll div */}
      <HireAgentModal
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        orgName={orgName}
        onHire={handleHire}
      />
    </>
  );
}
