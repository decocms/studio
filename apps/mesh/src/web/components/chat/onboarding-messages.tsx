/**
 * OnboardingMessages
 *
 * Mocked onboarding transcript rendered inside Chat.Main.
 * State machine: recommend → proposed → approved.
 * No interview questions — goes straight to agent recommendation.
 */

import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { StreamingMessage } from "./streaming-message.tsx";
import { HireAgentModal } from "@/web/components/onboarding/hire-agent-modal.tsx";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  File06,
} from "@untitledui/icons";

// ─── Types ────────────────────────────────────────────────────────────────────

type Stage = "loading" | "recommend" | "proposed" | "approved";

const ALREADY_KNOWS = [
  "Brand colors & visual identity",
  "Tech stack (Shopify Plus)",
  "~4.8M monthly visitors",
  "Top 3 competitors identified",
];

// ─── Sub-components ───────────────────────────────────────────────────────────

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

/**
 * AgentTaskCard
 *
 * Renders a single task the way the normal /tasks list renders rows —
 * same status badge, same structure — so the user recognises it as a
 * real task. Clicking opens the blog workspace.
 */
function AgentTaskCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mx-4">
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left hover:bg-muted/20 transition-colors group"
      >
        {/* Agent icon */}
        <div className="flex items-center justify-center size-8 rounded-lg bg-violet-100 text-violet-600 shrink-0">
          <File06 size={15} />
        </div>

        {/* Title + agent name */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            Write: "Best smart home accessories under $50"
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Blog Post Generator · 18K searches/mo · low competition
          </p>
        </div>

        {/* Status badge — same as tasks.tsx requires_action */}
        <Badge
          variant="outline"
          className="gap-1 text-blue-600 border-blue-600/40 shrink-0"
        >
          <AlertCircle size={11} />
          Review draft
        </Badge>

        <ArrowRight
          size={14}
          className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0"
        />
      </button>
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

  const [stage, setStage] = useState<Stage>("loading");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const welcomeText = `I've analyzed **${domain}** and found a few things worth addressing — including a slow LCP on mobile (4.2s), 67% of product pages missing meta descriptions, and real SEO opportunities in the content gap.\n\nBased on this, I have a recommendation.`;

  function handleHire() {
    localStorage.setItem("mesh_blog_hired", "true");
    window.dispatchEvent(new Event("mesh_blog_hired"));
    setStage("proposed");
  }

  function handleOpenTask() {
    navigate({
      to: "/$org/$project/tasks",
      params: { org: orgName, project: "storefront" },
    });
  }

  return (
    <>
      <div className="flex flex-col min-h-full max-w-2xl mx-auto w-full py-8 gap-6">
        {/* Welcome — streams in on mount */}
        <div className="px-4">
          <StreamingMessage
            id="onboarding-welcome"
            text={welcomeText}
            thinkingMs={300}
            onDone={() => setStage("recommend")}
          />
        </div>

        {/* Everything below only appears after welcome finishes */}
        {stage !== "loading" && (
          <>
            <DiagnosticCard domain={domain} />

            {stage === "recommend" && (
              <AgentRecommendationCard
                domain={domain}
                onHire={() => setDrawerOpen(true)}
              />
            )}

            {stage === "proposed" && (
              <>
                <div className="px-4">
                  <StreamingMessage
                    id="onboarding-post-hire"
                    text="Blog Post Generator is on your team. It's already drafted your first post — click the task below to review and approve it:"
                    thinkingMs={400}
                    onDone={() => {}}
                  />
                </div>
                <AgentTaskCard onOpen={handleOpenTask} />
              </>
            )}
          </>
        )}

        {/* Spacer */}
        <div className="h-8" />
      </div>

      {/* Modal — rendered outside scroll div */}
      <HireAgentModal
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onHire={handleHire}
      />
    </>
  );
}
