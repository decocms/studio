/**
 * Blog workspace — /$org/$project/blog
 *
 * Full-width centered blog post editor. No chat panel.
 * The post content, title, and meta are directly editable inline.
 * All content is mocked; taskId search param selects the active draft.
 */

import { useState } from "react";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Check, Edit01, Edit05, File06, Plus } from "@untitledui/icons";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Draft {
  id: string;
  title: string;
  keyword: string;
  volume: string;
  metaDescription: string;
  wordCount: number;
  readTime: number;
  category: string;
  content: Block[];
}

type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: string };

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
    category: "Buying Guides",
    content: [
      {
        type: "h2",
        text: "Why Smart Home Doesn't Have to Be Expensive",
      },
      {
        type: "p",
        text: "Smart home technology has come a long way. A few years ago, automating your home meant spending thousands of dollars on complex systems. Today, you can transform your living space with affordable gadgets that cost less than a dinner out.",
      },
      {
        type: "p",
        text: "In this guide, we've tested dozens of devices to find the best smart home accessories under $50 that actually deliver value.",
      },
      { type: "h2", text: "Top Picks Under $50" },
      {
        type: "p",
        text: "Whether you're just getting started or looking to expand your setup, these picks represent the best bang for your buck in 2026.",
      },
      { type: "h3", text: "Smart Plugs — The Gateway Drug" },
      {
        type: "p",
        text: "Smart plugs are the easiest way to start your smart home journey. For under $15, you can make any standard appliance controllable via app or voice command. Our top pick integrates seamlessly with Alexa, Google Home, and Apple HomeKit.",
      },
      {
        type: "p",
        text: "Key features to look for: scheduling, energy monitoring, and group control. The best models let you create automation routines — like turning off all devices when you leave home.",
      },
      { type: "h3", text: "Motion Sensors for Security and Automation" },
      {
        type: "p",
        text: "A good motion sensor does double duty: it helps secure your home and enables intelligent automation. Place one near your front door to trigger lights when you arrive, or use it to detect when rooms are occupied and adjust your thermostat accordingly.",
      },
      { type: "h2", text: "How to Choose the Right Accessories" },
      {
        type: "p",
        text: "Before buying, consider your existing ecosystem. If you're already using Alexa, prioritize Alexa-compatible devices for the smoothest experience. The same goes for Google Home and Apple HomeKit users.",
      },
      {
        type: "p",
        text: "Compatibility is the most common source of frustration for new smart home owners — so get this right first.",
      },
      { type: "h2", text: "Getting Started" },
      {
        type: "p",
        text: "We recommend starting with a smart plug and a smart bulb. Together, they cost under $30 and give you an immediate sense of what's possible. From there, you can expand based on what you find most useful.",
      },
      {
        type: "p",
        text: "The beauty of modern smart home devices is that most work together, so you're rarely locked into one brand.",
      },
    ],
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
    category: "How-To",
    content: [
      { type: "h2", text: "Smart Home Setup in 2026: Everything Has Changed" },
      {
        type: "p",
        text: "Setting up a smart home in 2026 is dramatically easier than it was even three years ago. The introduction of the Matter standard means most new devices work across ecosystems, eliminating the compatibility headaches that plagued early adopters.",
      },
      { type: "h2", text: "Step 1: Choose Your Ecosystem" },
      {
        type: "p",
        text: "Your first decision is which voice assistant ecosystem to build around. The three main contenders are Amazon Alexa, Google Home, and Apple HomeKit.",
      },
      { type: "h2", text: "Step 2: Start With the Hub" },
      {
        type: "p",
        text: "A hub is the brain of your smart home. It connects all your devices and enables local processing — meaning your automations work even when the internet is down.",
      },
      { type: "h2", text: "Step 3: Install Smart Lighting First" },
      {
        type: "p",
        text: "Lighting is the highest-impact and most immediate smart home upgrade. Start with the rooms you use most. A smart bulb in your living room lamp costs under $15 and delivers immediate value.",
      },
      { type: "h2", text: "Step 4: Build Your First Automation" },
      {
        type: "p",
        text: "The real magic happens with automations. Start simple: turn lights on when motion is detected after sunset, or gradually brighten lights in the bedroom 30 minutes before your wake time.",
      },
    ],
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
    category: "Platform Guides",
    content: [
      {
        type: "h2",
        text: "VTEX vs Shopify: Which Platform Is Right for Your DTC Brand?",
      },
      {
        type: "p",
        text: "Choosing the right e-commerce platform is one of the most consequential decisions a DTC brand makes. The platform shapes your tech stack, your team's workflow, your growth ceiling, and your total cost of ownership.",
      },
      { type: "h2", text: "The Short Answer" },
      {
        type: "p",
        text: "Choose Shopify Plus if you're a pure-play DTC brand focused on English-speaking markets, need fast time-to-market, and want the largest app ecosystem available.",
      },
      {
        type: "p",
        text: "Choose VTEX if you're operating in Latin America, need omnichannel out of the box, or have complex B2B or marketplace requirements.",
      },
      { type: "h2", text: "Shopify Plus: Strengths and Weaknesses" },
      {
        type: "p",
        text: "Shopify Plus remains the gold standard for DTC brands at the $1M–$50M GMV range. The platform's biggest strengths are its app ecosystem (8,000+ apps), developer talent availability, and rapid deployment capabilities.",
      },
      { type: "h2", text: "VTEX: Strengths and Weaknesses" },
      {
        type: "p",
        text: "VTEX's composable commerce architecture is built for complexity. The platform ships with native marketplace, omnichannel, and B2B capabilities that would require multiple apps and custom development on Shopify.",
      },
      { type: "h2", text: "Making the Decision" },
      {
        type: "p",
        text: "The right platform depends on your specific context. The platform that requires the least custom development to meet your current needs is usually the right choice.",
      },
    ],
  },
};

// ─── BlogEditor ───────────────────────────────────────────────────────────────

function BlogEditor({ draft }: { draft: Draft }) {
  const [approved, setApproved] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-8 py-12">
        {/* Category + meta row */}
        <div className="flex items-center gap-3 mb-6">
          <Badge variant="secondary" className="text-xs font-medium">
            {draft.category}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {draft.wordCount.toLocaleString()} words
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">
            {draft.readTime} min read
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-mono text-muted-foreground">
            {draft.volume} searches
          </span>
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <Edit01 size={12} />
            Click to edit
          </span>
        </div>

        {/* Title */}
        <h1
          contentEditable
          suppressContentEditableWarning
          className="text-4xl font-bold text-foreground leading-tight mb-4 outline-none focus:ring-2 focus:ring-ring/30 rounded-sm px-1 -mx-1 cursor-text"
        >
          {draft.title}
        </h1>

        {/* Meta description */}
        <div className="mb-8 rounded-xl border border-border bg-muted/30 px-4 py-3">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
            Meta description
          </p>
          <p
            contentEditable
            suppressContentEditableWarning
            className="text-sm text-muted-foreground leading-relaxed outline-none focus:text-foreground cursor-text"
          >
            {draft.metaDescription}
          </p>
        </div>

        {/* Article body */}
        <article className="flex flex-col gap-4">
          {draft.content.map((block, i) => {
            if (block.type === "h2") {
              return (
                <h2
                  key={i}
                  contentEditable
                  suppressContentEditableWarning
                  className="text-2xl font-bold text-foreground mt-8 first:mt-0 mb-1 outline-none focus:ring-2 focus:ring-ring/30 rounded-sm px-1 -mx-1 cursor-text"
                >
                  {block.text}
                </h2>
              );
            }
            if (block.type === "h3") {
              return (
                <h3
                  key={i}
                  contentEditable
                  suppressContentEditableWarning
                  className="text-lg font-semibold text-foreground mt-4 mb-0.5 outline-none focus:ring-2 focus:ring-ring/30 rounded-sm px-1 -mx-1 cursor-text"
                >
                  {block.text}
                </h3>
              );
            }
            return (
              <p
                key={i}
                contentEditable
                suppressContentEditableWarning
                className="text-base text-foreground leading-[1.75] outline-none focus:ring-2 focus:ring-ring/30 rounded-sm px-1 -mx-1 cursor-text"
              >
                {block.text}
              </p>
            );
          })}
        </article>

        {/* Footer actions */}
        <div className="mt-16 pt-8 border-t border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono bg-muted px-2 py-1 rounded-md">
              {draft.keyword}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm">
              <Edit05 size={13} />
              Regenerate
            </Button>
            <Button
              size="sm"
              variant={approved ? "outline" : "default"}
              className={approved ? "text-emerald-600 border-emerald-300" : ""}
              onClick={() => setApproved(true)}
            >
              {approved ? (
                <>
                  <Check size={13} />
                  Approved
                </>
              ) : (
                <>
                  <Check size={13} />
                  Approve & publish
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── BlogList ─────────────────────────────────────────────────────────────────

const LIST_POSTS: {
  id: string;
  title: string;
  status: "draft" | "published" | "scheduled";
  category: string;
  wordCount: number;
  updatedAt: string;
}[] = [
  {
    id: "bp-1",
    title: DRAFTS["bp-1"]!.title,
    status: "draft",
    category: DRAFTS["bp-1"]!.category,
    wordCount: DRAFTS["bp-1"]!.wordCount,
    updatedAt: "2h ago",
  },
  {
    id: "bp-2",
    title: DRAFTS["bp-2"]!.title,
    status: "draft",
    category: DRAFTS["bp-2"]!.category,
    wordCount: DRAFTS["bp-2"]!.wordCount,
    updatedAt: "1d ago",
  },
  {
    id: "bp-3",
    title: DRAFTS["bp-3"]!.title,
    status: "published",
    category: DRAFTS["bp-3"]!.category,
    wordCount: DRAFTS["bp-3"]!.wordCount,
    updatedAt: "3d ago",
  },
];

const STATUS_STYLES = {
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  scheduled: "bg-blue-50 text-blue-700 border-blue-200",
};

function BlogList({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-8 py-8 flex flex-col gap-4">
        {LIST_POSTS.map((post) => (
          <button
            key={post.id}
            type="button"
            onClick={() => onOpen(post.id)}
            className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 text-left hover:bg-muted/20 transition-colors group"
          >
            <div className="flex items-center justify-center size-9 rounded-lg bg-violet-100 text-violet-600 shrink-0">
              <File06 size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {post.title}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {post.category} · {post.wordCount.toLocaleString()} words ·{" "}
                {post.updatedAt}
              </p>
            </div>
            <span
              className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLES[post.status]}`}
            >
              {post.status}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BlogPage() {
  const { org, project } = useProjectContext();
  const navigate = useNavigate();
  const { taskId } = useSearch({ strict: false }) as { taskId?: string };

  const draft = taskId ? ((DRAFTS[taskId] ?? DRAFTS["bp-1"]) as Draft) : null;

  function handleOpenPost(id: string) {
    navigate({
      to: "/$org/$project/blog",
      params: { org: org.slug, project: project.slug },
      search: { taskId: id },
    });
  }

  function handleBackToList() {
    navigate({
      to: "/$org/$project/blog",
      params: { org: org.slug, project: project.slug },
      search: {},
    });
  }

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                {draft ? (
                  <button
                    type="button"
                    onClick={handleBackToList}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Blog
                  </button>
                ) : (
                  <BreadcrumbPage>Blog</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {draft && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{draft.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        {!draft && (
          <Page.Header.Right>
            <Button size="sm" variant="outline">
              <Plus size={13} />
              New post
            </Button>
          </Page.Header.Right>
        )}
      </Page.Header>

      <Page.Content className="flex flex-col overflow-hidden">
        {draft ? (
          <BlogEditor draft={draft} />
        ) : (
          <BlogList onOpen={handleOpenPost} />
        )}
      </Page.Content>
    </Page>
  );
}
