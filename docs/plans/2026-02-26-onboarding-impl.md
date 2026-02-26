# Onboarding Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the post-login onboarding flow to demo the full agent hire journey — from welcome + diagnostic context → hire modal → task proposals → blog workspace — all mocked.

**Architecture:** `onboarding-messages.tsx` drives a 4-stage state machine (recommend → hiring → proposed → approved). A `HireAgentModal` Dialog (two-column layout) handles the hire UX. After hire, mocked task cards navigate to a new `/blog` route that shows a split blog-draft-viewer + chat panel.

**Tech Stack:** React 19, TanStack Router, Tailwind v4, @deco/ui (Sheet, Dialog, Button), @untitledui/icons. Everything is mocked — no API calls, no TDD required.

---

### Task 1: Create `hire-agent-modal.tsx`

**Files:**
- Create: `apps/mesh/src/web/components/onboarding/hire-agent-modal.tsx`

This is a Dialog (full modal, NOT a Sheet/drawer) with a **two-column layout**:
- **Left column**: agent identity, "what it already knows" from diagnostic, plugins it installs
- **Right column**: optional connections (mocked connect buttons), autonomy selector, hire CTA

Use `Dialog` from `@deco/ui/components/dialog.tsx`. Max width `max-w-2xl` or `max-w-3xl`, no overlay scroll — the modal should be tall enough to show everything without scrolling.

**Step 1: Create the component**

```tsx
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  ArrowRight,
  Check,
  FileText,
  Package,
  SearchMd,
  ShoppingBag02,
  Github,
  Lightning01,
} from "@untitledui/icons";

// ─── Types ───────────────────────────────────────────────────────────────────

type AutonomyMode = "review" | "monitor" | "autonomous";

interface Connection {
  name: string;
  iconUrl: string;
  description: string;
}

// ─── Static data ─────────────────────────────────────────────────────────────

const CONNECTIONS: Connection[] = [
  {
    name: "Google Search Console",
    iconUrl: "https://www.google.com/s2/favicons?domain=search.google.com&sz=32",
    description: "Targets keywords you can actually win",
  },
  {
    name: "Shopify",
    iconUrl: "https://www.google.com/s2/favicons?domain=shopify.com&sz=32",
    description: "Uses real product data in posts",
  },
  {
    name: "GitHub",
    iconUrl: "https://www.google.com/s2/favicons?domain=github.com&sz=32",
    description: "Pushes approved posts directly to your repo",
  },
];

const AUTONOMY_OPTIONS: {
  id: AutonomyMode;
  label: string;
  description: string;
}[] = [
  {
    id: "review",
    label: "Review",
    description: "Agent proposes — you approve before anything happens",
  },
  {
    id: "monitor",
    label: "Monitor",
    description: "Reports and suggestions only, never acts",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    description: "Agent acts and notifies you of outcomes",
  },
];

// ─── Props ───────────────────────────────────────────────────────────────────

export interface HireAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  onHire: (mode: AutonomyMode) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function HireAgentModal({
  open,
  onOpenChange,
  orgName,
  onHire,
}: HireAgentModalProps) {
  const [autonomy, setAutonomy] = useState<AutonomyMode>("review");
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);

  const domain = orgName.replace(/-/g, ".").toLowerCase();

  function handleConnect(name: string) {
    setConnecting(name);
    setTimeout(() => {
      setConnected((prev) => new Set([...prev, name]));
      setConnecting(null);
    }, 800);
  }

  function handleHire() {
    onHire(autonomy);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] sm:max-w-[420px] flex flex-col gap-0 p-0 overflow-y-auto"
      >
        {/* Header */}
        <SheetHeader className="p-6 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center size-10 rounded-xl bg-violet-50 text-violet-500">
              <FileText size={20} />
            </div>
            <div>
              <SheetTitle className="text-base font-semibold">
                Blog Post Generator
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Writes SEO content in your brand voice
              </p>
            </div>
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-6 flex-1">
          {/* What it already knows */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Already knows about {domain}
            </p>
            <div className="flex flex-col gap-2">
              {[
                "Brand colors & visual identity",
                "Tech stack (Shopify Plus)",
                "~4.8M monthly visitors",
                "Top 3 competitors identified",
              ].map((fact) => (
                <div key={fact} className="flex items-center gap-2">
                  <Check size={13} className="text-emerald-500 shrink-0" />
                  <p className="text-sm text-foreground">{fact}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Plugins it installs */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Installs
            </p>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center justify-center size-8 rounded-lg bg-violet-50 text-violet-500">
                <Package size={15} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Blog</p>
                <p className="text-xs text-muted-foreground">
                  Sidebar workspace for drafts & queue
                </p>
              </div>
            </div>
          </section>

          {/* Optional connections */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Optional connections
            </p>
            <p className="text-xs text-muted-foreground mb-3">
              Agent works without these — connect later to unlock more.
            </p>
            <div className="flex flex-col gap-2">
              {CONNECTIONS.map((conn) => {
                const isConnected = connected.has(conn.name);
                const isConnecting = connecting === conn.name;
                return (
                  <div
                    key={conn.name}
                    className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3"
                  >
                    <IntegrationIcon
                      icon={conn.iconUrl}
                      name={conn.name}
                      size="xs"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {conn.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {conn.description}
                      </p>
                    </div>
                    {isConnected ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 shrink-0">
                        <Check size={12} />
                        Connected
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        disabled={isConnecting}
                        onClick={() => handleConnect(conn.name)}
                      >
                        {isConnecting ? "Connecting..." : "Connect"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Autonomy */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              How autonomous should it be?
            </p>
            <div className="flex flex-col gap-2">
              {AUTONOMY_OPTIONS.map((option) => {
                const isSelected = autonomy === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setAutonomy(option.id)}
                    className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? "border-foreground bg-muted/40"
                        : "border-border bg-muted/10 hover:bg-muted/20"
                    }`}
                  >
                    <div
                      className={`mt-0.5 size-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        isSelected
                          ? "border-foreground bg-foreground"
                          : "border-muted-foreground"
                      }`}
                    >
                      {isSelected && (
                        <div className="size-1.5 rounded-full bg-background" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {option.label}
                        {option.id === "review" && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            recommended
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {option.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        {/* Footer CTA */}
        <div className="p-6 pt-4 border-t border-border">
          <Button className="w-full" onClick={handleHire}>
            Hire Blog Post Generator
            <ArrowRight size={14} />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

**Step 2: Format**

```bash
bun run fmt
```

**Step 3: Commit**

```bash
git add apps/mesh/src/web/components/onboarding/hire-agent-modal.tsx
git commit -m "feat(onboarding): add HireAgentModal component"
```

---

### Task 2: Rewrite `onboarding-messages.tsx`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/onboarding-messages.tsx`

Full rewrite. Replaces 3-question flow with: welcome + expandable diagnostic + one agent recommendation card → hire drawer → task proposal cards → done/invite state.

**Step 1: Replace the entire file**

```tsx
/**
 * OnboardingMessages
 *
 * 4-stage mocked onboarding inside Chat.Main:
 *   recommend → hiring → proposed → approved
 *
 * Stage "recommend": welcome + diagnostic card + Blog Post Generator card
 * Stage "hiring":    HireAgentModal open
 * Stage "proposed":  task proposal cards (3 blog topics)
 * Stage "approved":  done state + invite CTA
 */

import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { MemoizedMarkdown } from "./markdown.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { HireAgentModal } from "@/web/components/onboarding/hire-agent-modal.tsx";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Globe01,
  Lightning01,
  SearchMd,
  Users03,
  CheckDone01,
} from "@untitledui/icons";

// ─── Types ────────────────────────────────────────────────────────────────────

type Stage = "recommend" | "hiring" | "proposed" | "approved";

interface TaskProposal {
  id: string;
  title: string;
  keyword: string;
  searches: string;
  competition: "low" | "medium" | "high";
  impact: string;
}

// ─── Static data ──────────────────────────────────────────────────────────────

const TASK_PROPOSALS: TaskProposal[] = [
  {
    id: "bp-1",
    title: "Best smart home accessories under $50",
    keyword: "best smart home accessories under $50",
    searches: "18K/mo",
    competition: "low",
    impact: "+~12% organic traffic",
  },
  {
    id: "bp-2",
    title: "How to set up a smart home in 2026",
    keyword: "how to set up a smart home 2026",
    searches: "41K/mo",
    competition: "medium",
    impact: "+~8% organic traffic",
  },
  {
    id: "bp-3",
    title: "VTEX vs Shopify for DTC brands",
    keyword: "vtex vs shopify dtc",
    searches: "6K/mo",
    competition: "high",
    impact: "+~5% conversion intent",
  },
];

const COMPETITION_COLORS = {
  low: "text-emerald-600 bg-emerald-50",
  medium: "text-amber-600 bg-amber-50",
  high: "text-rose-600 bg-rose-50",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function AssistantRow({ content }: { content: string }) {
  return (
    <div className="w-full min-w-0 flex items-start text-foreground flex-row px-4">
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
    <div className="mx-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Globe01 size={15} className="text-muted-foreground shrink-0" />
          <p className="text-sm font-medium text-foreground">
            See full diagnostic for {domain}
          </p>
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 rounded-xl border border-border bg-card p-4 flex flex-col gap-4">
          {/* Performance */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Performance
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                { label: "LCP", value: "4.2s", status: "Poor", color: "text-rose-500" },
                { label: "CLS", value: "0.12", status: "Needs improvement", color: "text-amber-500" },
                { label: "Mobile score", value: "42 / 100", status: "", color: "text-amber-500" },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{item.label}</span>
                  <span className={`text-xs font-medium ${item.color}`}>
                    {item.value} {item.status && `· ${item.status}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* SEO */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              SEO
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                { label: "Meta descriptions", value: "67% missing", color: "text-rose-500" },
                { label: "Backlinks", value: "1,240 domains", color: "text-foreground" },
                { label: "Organic traffic", value: "~1.1M/mo", color: "text-foreground" },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{item.label}</span>
                  <span className={`text-xs font-medium ${item.color}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tech stack */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Stack
            </p>
            <div className="flex flex-wrap gap-1.5">
              {["Shopify Plus", "Klaviyo", "Google Ads", "Meta Pixel", "Hotjar"].map(
                (tech) => (
                  <span
                    key={tech}
                    className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
                  >
                    {tech}
                  </span>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRecommendationCard({
  onHire,
}: {
  onHire: () => void;
}) {
  return (
    <div className="mx-4">
      <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-xl bg-violet-50 text-violet-500 shrink-0">
            <FileText size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Blog Post Generator
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Writes SEO content in your brand voice
            </p>
          </div>
        </div>

        {/* What it does */}
        <p className="text-sm text-muted-foreground leading-relaxed">
          Generates optimized blog posts using your brand data and competitor
          analysis. Works immediately — no connections required to start.
        </p>

        {/* Already knows */}
        <div className="flex flex-wrap gap-2">
          {["brand identity", "tech stack", "~4.8M visitors/mo", "3 competitors"].map(
            (fact) => (
              <span
                key={fact}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground"
              >
                <Check size={10} className="text-emerald-500" />
                {fact}
              </span>
            ),
          )}
        </div>

        {/* CTA */}
        <Button onClick={onHire} className="w-full">
          Hire Blog Post Generator
          <ArrowRight size={14} />
        </Button>
      </div>

      {/* Store link */}
      <button
        type="button"
        className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
        onClick={() => {}}
      >
        Looking for something else? Browse agent store →
      </button>
    </div>
  );
}

function TaskProposalCards({
  onApprove,
}: {
  onApprove: (task: TaskProposal) => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4">
      {TASK_PROPOSALS.map((task, idx) => (
        <button
          key={task.id}
          type="button"
          onClick={() => onApprove(task)}
          className="flex items-start gap-4 rounded-xl border border-border bg-card px-4 py-4 text-left hover:bg-muted/20 transition-colors group"
        >
          <div className="flex items-center justify-center size-8 rounded-lg bg-violet-50 text-violet-500 shrink-0 mt-0.5">
            <FileText size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{task.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {task.searches} searches · {task.impact}
            </p>
            <span
              className={`inline-block mt-1.5 text-xs px-1.5 py-0.5 rounded-md font-medium ${COMPETITION_COLORS[task.competition]}`}
            >
              {task.competition} competition
            </span>
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

function DoneState({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="mx-4 flex flex-col gap-4">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 px-5 py-4 flex items-start gap-3">
        <div className="flex items-center justify-center size-8 rounded-full bg-emerald-100 text-emerald-600 shrink-0 mt-0.5">
          <CheckDone01 size={15} />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">
            Blog Post Generator is working
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your first draft is ready in the Blog workspace. Invite your team
            to review and publish.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={onComplete} className="w-full">
          Go to Blog workspace
          <ArrowRight size={14} />
        </Button>
        <Button
          variant="outline"
          onClick={onComplete}
          className="w-full"
        >
          <Users03 size={14} />
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

export function OnboardingMessages({
  orgName,
  onComplete,
}: OnboardingMessagesProps) {
  const domain = orgName.replace(/-/g, ".").toLowerCase();
  const [stage, setStage] = useState<Stage>("recommend");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();

  const welcomeText = `I've analyzed **${domain}** and found a few things worth addressing — a slow LCP on mobile, missing meta descriptions on 67% of product pages, and untapped keyword opportunities your competitors are winning.\n\nHere's what I recommend as your first step:`;

  const afterHireText = `Blog Post Generator is now part of your team. Here are the first 3 content opportunities I found for **${domain}**. Pick one to start writing:`;

  function handleHire() {
    localStorage.setItem("mesh_blog_hired", "true");
    window.dispatchEvent(new Event("mesh_blog_hired"));
    setStage("proposed");
  }

  function handleApprove(task: TaskProposal) {
    setStage("approved");
    // Navigate to blog workspace after short delay to show approved state
    setTimeout(() => {
      navigate({
        to: "/$org/$project/blog",
        params: {
          org: orgName,
          project: "storefront",
        },
        search: { taskId: task.id },
      });
    }, 1200);
  }

  return (
    <div className="flex flex-col min-h-full max-w-2xl mx-auto w-full py-8 gap-5">
      {/* Welcome message */}
      <AssistantRow content={welcomeText} />

      {/* Diagnostic card (expandable, always visible) */}
      <DiagnosticCard domain={domain} />

      {/* Stage: recommend */}
      {stage === "recommend" && (
        <AgentRecommendationCard onHire={() => setDrawerOpen(true)} />
      )}

      {/* Stage: proposed */}
      {stage === "proposed" && (
        <>
          <AssistantRow content={afterHireText} />
          <TaskProposalCards onApprove={handleApprove} />
        </>
      )}

      {/* Stage: approved */}
      {stage === "approved" && (
        <>
          <AssistantRow content="Got it. Writing your first draft now..." />
          <DoneState onComplete={onComplete} />
        </>
      )}

      {/* Hire drawer */}
      <HireAgentModal
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        orgName={orgName}
        onHire={handleHire}
      />

      <div className="h-8" />
    </div>
  );
}
```

**Step 2: Format**

```bash
bun run fmt
```

**Step 3: Type check**

```bash
bun run check 2>&1 | grep -A2 "onboarding-messages\|hire-agent-drawer" || echo "no errors in target files"
```

**Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/onboarding-messages.tsx
git commit -m "feat(onboarding): rewrite onboarding messages with hire flow"
```

---

### Task 3: Create `blog.tsx` route (blog workspace)

**Files:**
- Create: `apps/mesh/src/web/routes/orgs/blog.tsx`

A mocked split layout: left side shows a blog draft artifact (title, meta, content, keyword), right side shows a mocked chat with the Blog Post Generator agent. The `taskId` search param selects which draft to show.

**Step 1: Create the component**

```tsx
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useSearch } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  FileText,
  Send01,
  User01,
} from "@untitledui/icons";

// ─── Mocked drafts ────────────────────────────────────────────────────────────

const DRAFTS: Record<
  string,
  {
    title: string;
    keyword: string;
    searches: string;
    meta: string;
    wordCount: number;
    readTime: string;
    content: string;
  }
> = {
  "bp-1": {
    title: "Best Smart Home Accessories Under $50",
    keyword: "best smart home accessories under $50",
    searches: "18K/mo",
    meta: "Discover our top-rated smart home accessories that won't break the bank. From voice assistants to smart plugs — all under $50.",
    wordCount: 1240,
    readTime: "5 min",
    content: `## Why Smart Home Doesn't Have to Be Expensive

The smart home revolution is here — and it doesn't require a five-figure budget. With the right accessories, you can automate your home for under $50 per device and still get a seamless, connected experience.

### Our Top Picks Under $50

**1. Smart Plugs ($12–$18)**
Turn any device into a smart device. Schedule lights, fans, and coffee makers with a simple app.

**2. Motion Sensors ($15–$25)**
Automate lighting and security alerts. Works with Alexa, Google Home, and Apple HomeKit.

**3. Smart Bulbs ($8–$20 each)**
Set the mood, save energy, and never fumble for a light switch again.

**4. Mini Smart Cameras ($35–$45)**
Keep an eye on what matters — pets, packages, and front doors.

### Getting Started

Start with one room and one automation. The most popular first step is automating your bedroom lights to dim at sunset. Once you feel the magic, you'll want more.`,
  },
  "bp-2": {
    title: "How to Set Up a Smart Home in 2026",
    keyword: "how to set up a smart home 2026",
    searches: "41K/mo",
    meta: "Your complete guide to building a connected smart home in 2026 — from choosing your ecosystem to automating your first room in under an hour.",
    wordCount: 1820,
    readTime: "7 min",
    content: `## Smart Homes in 2026: Simpler Than Ever

Setting up a smart home has never been more accessible. Modern devices are designed to work together, and most setups take less than an afternoon.

### Step 1: Choose Your Ecosystem

Pick one of the three major ecosystems and stick with it:

- **Amazon Alexa** — Best value, widest device compatibility
- **Google Home** — Best for Android users, natural language
- **Apple HomeKit** — Best for iPhone users, strongest privacy

### Step 2: Start With a Hub

A smart speaker doubles as your control center. Place it in the room you use most.

### Step 3: Add Devices Room by Room

Don't try to automate everything at once. Start with: lights → thermostat → security.`,
  },
  "bp-3": {
    title: "VTEX vs Shopify for DTC Brands: The 2026 Comparison",
    keyword: "vtex vs shopify dtc",
    searches: "6K/mo",
    meta: "VTEX or Shopify for your DTC brand? We compare pricing, flexibility, and scalability to help you make the right call in 2026.",
    wordCount: 2100,
    readTime: "8 min",
    content: `## The Real Difference Between VTEX and Shopify

Both platforms can power a successful DTC brand. But they serve different stages of growth — and making the wrong choice costs time and money.

### Shopify: Best For Early-Stage DTC

Shopify wins on speed to market. You can have a beautiful, fully-functional store live in days without an engineering team.

**Best for:** Brands under $10M ARR, lean teams, standard checkout flows.

### VTEX: Best For High-Volume DTC

VTEX shines at scale. Its headless architecture gives engineering teams full control over performance, checkout logic, and omnichannel flows.

**Best for:** Brands over $50M ARR, complex catalog management, multi-market operations.

### Our Recommendation

If you're just starting out or under $10M in revenue: Shopify. If you're scaling internationally or need complex commerce logic: VTEX.`,
  },
};

const DEFAULT_DRAFT = DRAFTS["bp-1"];

// ─── Mocked chat messages ─────────────────────────────────────────────────────

const AGENT_MESSAGES = [
  "Here's your first blog post draft. I've optimized it for **\"best smart home accessories under $50\"** — 18K monthly searches with low competition.",
  "The meta description is 155 characters and the content is 1,240 words. Want me to adjust the tone, swap the hero image, or target a different keyword?",
];

// ─── Component ───────────────────────────────────────────────────────────────

function DraftViewer({
  draft,
  onApprove,
  approved,
}: {
  draft: (typeof DRAFTS)["bp-1"];
  onApprove: () => void;
  approved: boolean;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Draft header */}
      <div className="flex-none p-5 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-foreground leading-snug">
              {draft.title}
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {draft.wordCount} words · {draft.readTime} read ·{" "}
              <span className="font-medium text-foreground">
                {draft.searches} searches
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {approved ? (
              <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <Check size={14} />
                Approved
              </div>
            ) : (
              <Button size="sm" onClick={onApprove}>
                <Check size={13} />
                Approve
              </Button>
            )}
          </div>
        </div>

        {/* Meta + keyword */}
        <div className="mt-3 flex flex-col gap-2">
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground mb-0.5">
              Meta description
            </p>
            <p className="text-xs text-foreground">{draft.meta}</p>
          </div>
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground mb-0.5">
              Target keyword
            </p>
            <p className="text-xs text-foreground font-mono">{draft.keyword}</p>
          </div>
        </div>
      </div>

      {/* Draft content */}
      <div className="flex-1 overflow-y-auto p-5">
        <article className="prose prose-sm max-w-none text-foreground">
          {draft.content.split("\n\n").map((para, i) => {
            if (para.startsWith("## ")) {
              return (
                <h2
                  key={i}
                  className="text-base font-semibold text-foreground mt-4 mb-2"
                >
                  {para.slice(3)}
                </h2>
              );
            }
            if (para.startsWith("### ")) {
              return (
                <h3
                  key={i}
                  className="text-sm font-semibold text-foreground mt-3 mb-1.5"
                >
                  {para.slice(4)}
                </h3>
              );
            }
            if (para.startsWith("**") && para.includes("**\n")) {
              const [title, ...rest] = para.split("\n");
              return (
                <div key={i} className="mb-3">
                  <p className="text-sm font-semibold text-foreground">
                    {title.replace(/\*\*/g, "")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {rest.join(" ")}
                  </p>
                </div>
              );
            }
            return (
              <p
                key={i}
                className="text-sm text-foreground leading-relaxed mb-3"
              >
                {para.replace(/\*\*(.*?)\*\*/g, "$1")}
              </p>
            );
          })}
        </article>
      </div>
    </div>
  );
}

function AgentChat({ draftTitle }: { draftTitle: string }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { role: "agent" | "user"; text: string }[]
  >([
    { role: "agent", text: AGENT_MESSAGES[0] },
    { role: "agent", text: AGENT_MESSAGES[1] },
  ]);
  const [sending, setSending] = useState(false);

  function handleSend() {
    if (!input.trim()) return;
    const userMsg = input.trim();
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          text: "Got it — I'll update the draft with that change. Give me a moment.",
        },
      ]);
      setSending(false);
    }, 1000);
  }

  return (
    <div className="flex flex-col h-full border-l border-border">
      {/* Chat header */}
      <div className="flex-none px-4 py-3 border-b border-border flex items-center gap-2">
        <div className="flex items-center justify-center size-6 rounded-lg bg-violet-50 text-violet-500">
          <FileText size={12} />
        </div>
        <p className="text-sm font-medium text-foreground">
          Blog Post Generator
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "agent" && (
              <div className="flex items-center justify-center size-6 rounded-full bg-violet-50 text-violet-500 mr-2 mt-0.5 shrink-0">
                <FileText size={11} />
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-muted text-foreground rounded-tr-sm"
                  : "bg-muted/30 text-foreground rounded-tl-sm border border-border"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center justify-center size-6 rounded-full bg-violet-50 text-violet-500 mr-2 mt-0.5 shrink-0">
              <FileText size={11} />
            </div>
            <div className="bg-muted/30 border border-border rounded-2xl rounded-tl-sm px-3 py-2">
              <div className="flex gap-1 items-center h-4">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="size-1.5 rounded-full bg-muted-foreground animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex-none p-3 border-t border-border">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask to edit the draft..."
            rows={2}
            className="flex-1 resize-none rounded-xl border border-border bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <Button
            size="icon"
            className="size-9 shrink-0"
            disabled={!input.trim() || sending}
            onClick={handleSend}
          >
            <Send01 size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BlogPage() {
  const { org, project } = useProjectContext();
  // taskId comes from search param set by onboarding task card click
  const search = useSearch({ strict: false }) as { taskId?: string };
  const taskId = search.taskId ?? "bp-1";
  const draft = DRAFTS[taskId] ?? DEFAULT_DRAFT;
  const [approved, setApproved] = useState(false);

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <p className="text-sm font-medium text-foreground">Blog</p>
        </Page.Header.Left>
        <Page.Header.Right>
          {approved && (
            <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
              <Check size={14} />
              Added to queue
            </div>
          )}
        </Page.Header.Right>
      </Page.Header>

      <Page.Content className="flex-1 overflow-hidden">
        <div className="h-full grid grid-cols-[1fr_320px]">
          <DraftViewer
            draft={draft}
            onApprove={() => setApproved(true)}
            approved={approved}
          />
          <AgentChat draftTitle={draft.title} />
        </div>
      </Page.Content>
    </Page>
  );
}
```

**Step 2: Format**

```bash
bun run fmt
```

**Step 3: Type check**

```bash
bun run check 2>&1 | grep -A2 "blog.tsx" || echo "no errors in blog.tsx"
```

**Step 4: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/blog.tsx
git commit -m "feat(onboarding): add mocked blog workspace route"
```

---

### Task 4: Register blog route + add Blog sidebar item

**Files:**
- Modify: `apps/mesh/src/web/index.tsx`
- Modify: `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx`

**Step 1: Register the blog route in `index.tsx`**

After the `tasksRoute` definition (around line 232), add:

```tsx
const blogRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/blog",
  component: lazyRouteComponent(() => import("./routes/orgs/blog.tsx")),
  validateSearch: (search: Record<string, unknown>) => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});
```

Then add `blogRoute` to the `projectRoutes` array (around line 493):

```tsx
const projectRoutes = [
  projectHomeRoute,
  tasksRoute,
  blogRoute,          // ← add this
  projectSettingsRoute,
  // ...rest unchanged
];
```

**Step 2: Add Blog sidebar item in `use-project-sidebar-items.tsx`**

Add an import for `PenTool01` (or `FileText` from untitledui) at the top of the file (with other icon imports):

```tsx
import {
  BarChart10,
  Building02,
  CheckDone01,
  Container,
  FaceSmile,
  FileText,       // ← add
  Folder,
  Home02,
  SearchMd,
  Settings01,
  Users03,
} from "@untitledui/icons";
```

Then, inside `useProjectSidebarItems`, before the `return sections` statement in the non-org-admin branch (around line 300), add a blog item that reads from localStorage:

```tsx
// Blog plugin item — appears after Blog Post Generator is hired
const blogHired =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("mesh_blog_hired") === "true";

const blogItem: NavigationSidebarItem = {
  key: "blog",
  label: "Blog",
  icon: <FileText />,
  isActive: isActiveRoute("blog"),
  onClick: () =>
    navigate({
      to: "/$org/$project/blog",
      params: { org, project },
    }),
};
```

Then in the sections array for non-org-admin projects (around line 296), update the items:

```tsx
const projectItems: NavigationSidebarItem[] = [
  homeItem,
  projectTasksItem,
  diagnosticItem,
  ...(blogHired ? [blogItem] : []),   // ← add
];
```

**Step 3: Format**

```bash
bun run fmt
```

**Step 4: Type check**

```bash
bun run check 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add apps/mesh/src/web/index.tsx apps/mesh/src/web/hooks/use-project-sidebar-items.tsx
git commit -m "feat(onboarding): register blog route and add Blog sidebar item after hire"
```

---

## How to test the full demo flow

1. Start the dev server: `bun run --cwd=apps/mesh dev:client`
2. Go to `/onboarding` → enter a URL → wait for diagnostic → click login CTA
3. Complete login → lands at `/$org/storefront?onboarding=true`
4. Chat shows welcome + diagnostic card + Blog Post Generator recommendation
5. Click **"See full diagnostic"** → expands inline, no navigation
6. Click **"Hire Blog Post Generator"** → drawer opens from right
7. Explore autonomy modes, optional connections → click **"Hire Blog Post Generator"**
8. Drawer closes, chat shows task proposals (3 blog topics)
9. Click a task card → navigates to `/$org/storefront/blog?taskId=bp-1`
10. Blog workspace: left shows draft, right shows agent chat
11. Type in chat → agent responds
12. Click **"Approve"** → draft marked as approved
13. **"Blog"** sidebar item should now appear (localStorage flag set)
