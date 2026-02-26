/**
 * Blog workspace — /$org/$project/blog
 *
 * Split layout: left DraftViewer + right AgentChat panel.
 * All content is mocked. taskId search param selects the active draft.
 */

import { useState } from "react";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import { useSearch } from "@tanstack/react-router";
import { Check, FileText, Send01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Draft {
  id: string;
  title: string;
  keyword: string;
  volume: string;
  metaDescription: string;
  wordCount: number;
  readTime: number;
  content: string;
}

interface ChatMsg {
  id: string;
  role: "agent" | "user";
  text: string;
}

// ─── Mocked drafts ────────────────────────────────────────────────────────────

const DRAFTS: Record<string, Draft> = {
  "bp-1": {
    id: "bp-1",
    title: "Best Smart Home Accessories Under $50",
    keyword: "best smart home accessories under $50",
    volume: "18K/mo",
    metaDescription:
      "Discover the best smart home accessories under $50. From smart plugs to voice assistants, upgrade your home without breaking the bank.",
    wordCount: 1240,
    readTime: 5,
    content: `## Why Smart Home Doesn't Have to Be Expensive

Smart home technology has come a long way. A few years ago, automating your home meant spending thousands of dollars on complex systems. Today, you can transform your living space with affordable gadgets that cost less than a dinner out.

In this guide, we've tested dozens of devices to find the best smart home accessories under $50 that actually deliver value.

## Top Picks Under $50

Whether you're just getting started or looking to expand your setup, these picks represent the best bang for your buck in 2026.

### Smart Plugs — The Gateway Drug

Smart plugs are the easiest way to start your smart home journey. For under $15, you can make any standard appliance controllable via app or voice command. Our top pick integrates seamlessly with Alexa, Google Home, and Apple HomeKit.

Key features to look for: scheduling, energy monitoring, and group control. The best models let you create automation routines — like turning off all devices when you leave home.

### Motion Sensors for Security and Automation

A good motion sensor does double duty: it helps secure your home and enables intelligent automation. Place one near your front door to trigger lights when you arrive, or use it to detect when rooms are occupied and adjust your thermostat accordingly.

## How to Choose the Right Accessories

Before buying, consider your existing ecosystem. If you're already using Alexa, prioritize Alexa-compatible devices for the smoothest experience. The same goes for Google Home and Apple HomeKit users.

Compatibility is the most common source of frustration for new smart home owners — so get this right first.

## Getting Started

We recommend starting with a smart plug and a smart bulb. Together, they cost under $30 and give you an immediate sense of what's possible. From there, you can expand based on what you find most useful.

The beauty of modern smart home devices is that most work together, so you're rarely locked into one brand.`,
  },
  "bp-2": {
    id: "bp-2",
    title: "How to Set Up a Smart Home in 2026",
    keyword: "how to set up a smart home in 2026",
    volume: "41K/mo",
    metaDescription:
      "Step-by-step guide to setting up a smart home in 2026. Learn which hub to choose, how to connect devices, and build your first automation.",
    wordCount: 1580,
    readTime: 6,
    content: `## Smart Home Setup in 2026: Everything Has Changed

Setting up a smart home in 2026 is dramatically easier than it was even three years ago. The introduction of the Matter standard means most new devices work across ecosystems, eliminating the compatibility headaches that plagued early adopters.

This guide walks you through the process from scratch — whether you're starting fresh or upgrading an existing setup.

## Step 1: Choose Your Ecosystem

Your first decision is which voice assistant ecosystem to build around. The three main contenders are Amazon Alexa, Google Home, and Apple HomeKit. Each has strengths and weaknesses.

Matter compatibility means you can mix and match more freely than before, but your hub choice still shapes your experience. Most users are happiest staying within one ecosystem for core functionality.

## Step 2: Start With the Hub

A hub is the brain of your smart home. It connects all your devices and enables local processing — meaning your automations work even when the internet is down.

In 2026, the best hubs offer Thread networking, which provides faster and more reliable connections for battery-powered sensors and switches.

## Step 3: Install Smart Lighting First

Lighting is the highest-impact and most immediate smart home upgrade. Start with the rooms you use most. A smart bulb in your living room lamp costs under $15 and delivers immediate value through scheduling, dimming, and scene control.

## Step 4: Add Environmental Sensors

Temperature, humidity, and occupancy sensors enable truly intelligent automation. When your home knows a room is occupied, it can adjust lighting and climate automatically. This is where the "smart" in smart home really shines.

## Step 5: Build Your First Automation

The real magic happens with automations. Start simple: turn lights on when motion is detected after sunset, or gradually brighten lights in the bedroom 30 minutes before your wake time.

Most platforms now offer visual automation builders that require no coding knowledge. Start with one automation, live with it for a week, then expand.`,
  },
  "bp-3": {
    id: "bp-3",
    title: "VTEX vs Shopify for DTC Brands: The 2026 Comparison",
    keyword: "vtex vs shopify for dtc brands",
    volume: "6K/mo",
    metaDescription:
      "VTEX vs Shopify for DTC brands in 2026 — a detailed comparison of features, pricing, scalability, and ecosystem for e-commerce teams.",
    wordCount: 2100,
    readTime: 8,
    content: `## VTEX vs Shopify: Which Platform Is Right for Your DTC Brand?

Choosing the right e-commerce platform is one of the most consequential decisions a DTC brand makes. The platform shapes your tech stack, your team's workflow, your growth ceiling, and your total cost of ownership.

In 2026, the VTEX vs Shopify debate has intensified as both platforms have made significant investments in their enterprise offerings.

## The Short Answer

**Choose Shopify Plus if:** You're a pure-play DTC brand focused on English-speaking markets, need fast time-to-market, and want the largest app ecosystem available.

**Choose VTEX if:** You're operating in Latin America, need omnichannel out of the box, or have complex B2B or marketplace requirements.

## Shopify Plus: Strengths and Weaknesses

Shopify Plus remains the gold standard for DTC brands at the $1M–$50M GMV range. The platform's biggest strengths are its app ecosystem (8,000+ apps), developer talent availability, and rapid deployment capabilities.

### Where Shopify Excels

The Shopify App Store is genuinely unmatched. For DTC brands, this means best-in-class tooling for email marketing (Klaviyo), loyalty programs (Yotpo, LoyaltyLion), subscription commerce (Recharge, Bold), and post-purchase experiences.

Shopify's checkout is consistently the highest-converting in the industry, with recent upgrades to extensibility making it even more customizable without sacrificing performance.

### Shopify's Limitations

Multi-country selling, while improved with Markets, still requires workarounds for truly complex international operations. Complex B2B scenarios and marketplace functionality remain areas where Shopify requires significant custom development.

## VTEX: Strengths and Weaknesses

VTEX's composable commerce architecture is built for complexity. The platform ships with native marketplace, omnichannel, and B2B capabilities that would require multiple apps and custom development on Shopify.

### Where VTEX Excels

VTEX's native omnichannel capabilities — connecting physical stores, digital channels, marketplaces, and fulfillment — in a single platform is a genuine competitive advantage for brands operating at scale across multiple channels.

In Latin America, VTEX has deep integrations with local payment methods, logistics providers, and tax frameworks that would take significant engineering time to replicate on other platforms.

## Making the Decision

The right platform depends on your specific context. Rather than declaring a winner, map your requirements against each platform's native strengths. The platform that requires the least custom development to meet your current needs is usually the right choice.`,
  },
};

// ─── DraftViewer ─────────────────────────────────────────────────────────────

function renderContent(content: string) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      elements.push(
        <h2
          key={key++}
          className="text-xl font-bold text-foreground mt-6 mb-2 first:mt-0"
        >
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3
          key={key++}
          className="text-base font-semibold text-foreground mt-4 mb-1.5"
        >
          {line.slice(4)}
        </h3>,
      );
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    } else {
      elements.push(
        <p
          key={key++}
          className="text-sm text-foreground leading-relaxed mb-0"
        >
          {line}
        </p>,
      );
    }
  }

  return elements;
}

function DraftViewer({ draft }: { draft: Draft }) {
  const [approved, setApproved] = useState(false);

  return (
    <div className="flex flex-col h-full overflow-hidden border-r border-border">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-foreground leading-tight">
            {draft.title}
          </h1>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
            <span>{draft.wordCount.toLocaleString()} words</span>
            <span>·</span>
            <span>{draft.readTime} min read</span>
            <span>·</span>
            <span className="font-mono">{draft.volume} searches</span>
          </div>
        </div>
        <Button
          size="sm"
          variant={approved ? "outline" : "default"}
          className={cn("shrink-0", approved && "text-emerald-600")}
          onClick={() => setApproved(true)}
        >
          {approved ? (
            <>
              <Check size={13} />
              Approved
            </>
          ) : (
            "Approve"
          )}
        </Button>
      </div>

      {/* Meta + keyword */}
      <div className="shrink-0 px-6 py-3 border-b border-border flex flex-col gap-2">
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground mb-1">
            Meta description
          </p>
          <p className="text-xs text-foreground leading-relaxed">
            {draft.metaDescription}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground mb-1">
            Target keyword
          </p>
          <p className="text-xs text-foreground font-mono">{draft.keyword}</p>
        </div>
      </div>

      {/* Article content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {renderContent(draft.content)}
      </div>
    </div>
  );
}

// ─── AgentChat ────────────────────────────────────────────────────────────────

const INITIAL_MESSAGES: ChatMsg[] = [
  {
    id: "init-1",
    role: "agent",
    text: "I've finished the first draft based on the top keyword opportunity. The content is structured for SEO with clear headings, a target keyword density of ~1.2%, and internal linking opportunities highlighted.",
  },
  {
    id: "init-2",
    role: "agent",
    text: "Let me know if you'd like any changes — I can adjust the tone, add a product recommendation section, or expand any of the sections.",
  },
];

function ThinkingDots() {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 flex items-center justify-center size-7 rounded-xl bg-violet-100 text-violet-600">
        <FileText size={14} />
      </div>
      <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
        <span className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

function AgentChat() {
  const [messages, setMessages] = useState<ChatMsg[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    setTimeout(() => {
      const agentMsg: ChatMsg = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: "Got it — I'll update the draft with that change.",
      };
      setMessages((prev) => [...prev, agentMsg]);
      setSending(false);
    }, 1000);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="flex items-center justify-center size-7 rounded-xl bg-violet-100 text-violet-600">
          <FileText size={14} />
        </div>
        <span className="text-sm font-semibold text-foreground">
          Blog Post Generator
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.map((msg) =>
          msg.role === "agent" ? (
            <div key={msg.id} className="flex items-start gap-3">
              <div className="shrink-0 flex items-center justify-center size-7 rounded-xl bg-violet-100 text-violet-600">
                <FileText size={14} />
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm text-foreground max-w-[85%]">
                {msg.text}
              </div>
            </div>
          ) : (
            <div key={msg.id} className="flex justify-end">
              <div className="rounded-2xl rounded-tr-sm bg-foreground px-4 py-2.5 text-sm text-background max-w-[85%]">
                {msg.text}
              </div>
            </div>
          ),
        )}
        {sending && <ThinkingDots />}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Ask for changes..."
            disabled={sending}
            className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <Button
            size="icon"
            className="shrink-0 size-9"
            disabled={!input.trim() || sending}
            onClick={handleSend}
            aria-label="Send message"
          >
            <Send01 size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BlogPage() {
  const { taskId } = useSearch({ strict: false }) as {
    taskId?: string;
  };

  const draft = DRAFTS[taskId ?? "bp-1"] ?? DRAFTS["bp-1"];

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <span className="text-sm font-medium text-foreground">Blog</span>
        </Page.Header.Left>
      </Page.Header>

      <Page.Content className="h-full overflow-hidden">
        <div className="h-full grid grid-cols-[1fr_320px]">
          <DraftViewer draft={draft} />
          <AgentChat />
        </div>
      </Page.Content>
    </Page>
  );
}
