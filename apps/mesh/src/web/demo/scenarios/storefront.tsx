/**
 * Scenario 1 — Business user: drop in your site, get an accurate diagnosis.
 *
 * A store owner pastes their URL; the agent captures the live page, runs a
 * performance + SEO audit, presents a real scorecard with the highest-impact
 * issues, proposes a fix plan, applies the fixes in parallel, and re-audits +
 * deploys. All rendered with the REAL chat components.
 */
import { DemoTopBar } from "../chrome";
import { Chat } from "@/web/components/chat";
import { DemoChatStreamProvider } from "../demo-chat-stream";
import type { DemoStores } from "../director-stores";
import type { Scenario } from "../types";
import { genericTool, proposePlan, takeScreenshot } from "../message-builders";

const SHOT =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='380'>
       <rect width='640' height='380' fill='#0b0b0f'/>
       <rect width='640' height='52' fill='#16161d'/>
       <circle cx='26' cy='26' r='5' fill='#ff5f57'/>
       <circle cx='44' cy='26' r='5' fill='#febc2e'/>
       <circle cx='62' cy='26' r='5' fill='#28c840'/>
       <rect x='120' y='17' width='400' height='18' rx='9' fill='#26262e'/>
       <rect x='40' y='92' width='240' height='150' rx='10' fill='#1d1d27'/>
       <rect x='300' y='92' width='300' height='26' rx='6' fill='#23232d'/>
       <rect x='300' y='132' width='240' height='14' rx='5' fill='#1b1b24'/>
       <rect x='300' y='156' width='260' height='14' rx='5' fill='#1b1b24'/>
       <rect x='300' y='196' width='120' height='34' rx='8' fill='#2f7d5b'/>
       <rect x='40' y='270' width='560' height='70' rx='10' fill='#15151d'/>
       <text x='320' y='362' fill='#5b6472' font-family='sans-serif' font-size='13' text-anchor='middle'>acme.com — home</text>
     </svg>`,
  );

function StorefrontStage({ stores }: { stores: DemoStores }) {
  return (
    <div className="flex h-full flex-col">
      <DemoTopBar org="Acme" agent="Storefront Optimizer" />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <DemoChatStreamProvider store={stores.getChat("main")}>
          <Chat>
            <Chat.Messages />
          </Chat>
        </DemoChatStreamProvider>
      </div>
    </div>
  );
}

const DIAGNOSIS = `### Audit results for acme.com

| Metric | Score | Status |
| --- | --- | --- |
| Performance | **38 / 100** | 🔴 Poor |
| Largest Contentful Paint | **4.2 s** | 🔴 Poor |
| Cumulative Layout Shift | **0.27** | 🔴 Poor |
| Interaction to Next Paint | **380 ms** | 🟠 Needs work |
| SEO | **64 / 100** | 🟠 Needs work |

**The four things costing you the most:**

1. **2.4 MB of unoptimized images** — the hero alone is a 1.1 MB PNG served full-size.
2. **Render-blocking CSS** — 3 stylesheets (180 KB) block first paint.
3. **No structured data** — missing Product & Organization JSON-LD, so you're invisible to rich results.
4. **Layout shift** from unsized images and late-loading web fonts.`;

const PLAN = `**Performance**
- Convert & compress images to WebP, resize the hero to its display size
- Inline critical CSS, defer the rest
- Reserve space for media + preload the primary font

**SEO**
- Add Product, Offer, and Organization JSON-LD
- Generate descriptive alt text for product imagery

**Safety**
- Apply on a preview branch, verify Lighthouse ≥ 90, then promote to production`;

const RESULT = `### Re-audit — deployed to production ✅

| Metric | Before | After |
| --- | --- | --- |
| Performance | 38 | **96** |
| Largest Contentful Paint | 4.2 s | **1.3 s** |
| Cumulative Layout Shift | 0.27 | **0.02** |
| Interaction to Next Paint | 380 ms | **140 ms** |
| SEO | 64 | **98** |

Live at **acme.com** — the homepage is **3.2× faster** and now eligible for product rich results. I'll keep watching and re-optimize automatically when new pages ship. 🚀`;

export const storefrontScenario: Scenario = {
  id: "storefront",
  title: "Drop in your site, get a diagnosis",
  Stage: StorefrontStage,
  endCard: {
    title: "Optimize your storefront, automatically",
    subtitle:
      "Connect your site and let agents ship the fixes — free to start.",
  },
  run: async (d) => {
    // 1) Setup — let the layout settle, then frame the story.
    await d.beat(700);
    d.caption("A store owner pastes their URL");
    await d.beat(1400);

    // 2) The ask.
    await d.user(
      "Here's my store: https://acme.com — can you make it faster and rank better?",
    );
    await d.beat(700);
    await d.think(
      "I'll capture the live homepage, run a performance + SEO audit, then rank every issue by impact before touching anything.",
      { cps: 80 },
    );
    await d.stream("On it — capturing your homepage now.", { cps: 44 });

    // 3) Look at the real page.
    await d.tool(
      takeScreenshot({ url: "https://acme.com", image: SHOT, latencyMs: 1900 }),
    );
    await d.beat(1200);

    // 4) Audit → diagnosis (hold long enough to read).
    d.caption("Running a full performance + SEO audit");
    await d.beat(900);
    await d.tool(
      genericTool({
        name: "lighthouse_audit",
        input: { url: "https://acme.com", categories: ["performance", "seo"] },
        output: { result: "Performance 38 · SEO 64 · 11 opportunities found" },
        latencyMs: 2200,
      }),
    );
    await d.stream("Here's what I found — measured, not guessed:", { cps: 44 });
    d.caption("An accurate diagnosis");
    await d.stream(DIAGNOSIS, { instant: true });
    await d.beat(4800);

    // 5) The plan.
    d.caption("A plan, ranked by impact");
    await d.beat(800);
    await d.stream("Here's the plan I'd apply:", { cps: 44 });
    await d.tool(proposePlan({ plan: PLAN, approved: true }));
    await d.beat(900);
    await d.stream("Approved — applying every fix on a preview branch.", {
      cps: 44,
    });

    // 6) Fixes cascade in parallel.
    d.caption("Fixing the highest-impact issues in parallel");
    await d.beat(600);
    await d.parallel(
      [
        genericTool({
          name: "optimize_images",
          output: { result: "14 images → WebP · 2.4 MB → 380 KB" },
          latencyMs: 2600,
        }),
        genericTool({
          name: "inline_critical_css",
          output: { result: "Critical CSS inlined · 3 stylesheets deferred" },
          latencyMs: 2400,
        }),
        genericTool({
          name: "add_structured_data",
          output: { result: "Product + Organization JSON-LD on 24 pages" },
          latencyMs: 2200,
        }),
        genericTool({
          name: "fix_layout_shift",
          output: { result: "Media sized + font preloaded · CLS 0.27 → 0.02" },
          latencyMs: 2000,
        }),
      ],
      650,
    );
    await d.beat(900);

    // 7) Ship + re-audit (hold to read).
    d.caption("Re-auditing and shipping to production");
    await d.beat(600);
    await d.tool(
      genericTool({
        name: "deploy_to_production",
        output: { result: "Promoted preview → production · acme.com" },
        latencyMs: 1900,
      }),
    );
    await d.stream(RESULT, { instant: true });
    await d.endTurn();
    d.caption("From audit to deployed — automatically");
    await d.beat(4500);
  },
};
