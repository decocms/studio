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
import { genericTool, takeScreenshot } from "../message-builders";

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
    d.endTurn(); // close the turn so later cards don't collapse into it
    await d.beat(4800);

    // 5) A real work plan — shown as a sprint, awaiting approval.
    d.caption("A work plan, laid out as a sprint");
    await d.beat(700);
    await d.stream("I've turned this into a sprint — review and approve:", {
      cps: 44,
    });
    d.showPlan("Sprint · Storefront performance", [
      { title: "Convert & compress images to WebP", detail: "2.4 MB → 380 KB" },
      {
        title: "Inline critical CSS, defer the rest",
        detail: "−180 KB blocking",
      },
      {
        title: "Add Product + Organization JSON-LD",
        detail: "across 24 pages",
      },
      { title: "Fix layout shift", detail: "sized media + font preload" },
      {
        title: "Open a PR & deploy to preview",
        detail: "reviewable, reversible",
      },
    ]);
    await d.beat(2000); // read the sprint

    // 6) Approve — the viewer clicks (ghost cursor).
    d.caption("Review the plan, then approve");
    d.showCursor();
    await d.beat(700);
    await d.click("approve-plan");
    d.acceptPlan();
    d.hideCursor();
    await d.beat(700);
    d.endTurn();

    // 7) Execute — the sprint board ticks as the agent works.
    d.caption("Approved — running the sprint");
    await d.stream("On it — working through the sprint on a preview branch.", {
      cps: 44,
    });
    for (const i of [0, 1, 2, 3]) {
      d.setTask(i, "active");
      await d.beat(1700);
      d.setTask(i, "done");
      await d.beat(400);
    }

    // 8) First deliverable: a pull request with the code changes.
    d.setTask(4, "active");
    d.caption("Opening a pull request with the changes");
    await d.stream("Opening a PR with the changes for review…", { cps: 44 });
    await d.beat(1400);
    d.openPR({
      number: 128,
      title: "perf: optimize storefront",
      branch: "perf/storefront-optimizations",
      files: 6,
      additions: 214,
      deletions: 88,
    });
    await d.beat(2000); // CI running
    d.passPRChecks();
    d.setTask(4, "done");
    await d.beat(1300);

    // 9) Merge (ghost cursor) → deploy → re-audit.
    d.caption("Checks pass — merge & ship");
    d.showCursor();
    await d.beat(700);
    await d.click("merge-pr");
    d.mergePR();
    d.hideCursor();
    await d.beat(500);
    await d.stream("Merged. Deploying to production…", { cps: 44 });
    await d.tool(
      genericTool({
        name: "deploy_to_production",
        output: { result: "Promoted preview → production · acme.com" },
        latencyMs: 1800,
      }),
    );
    await d.stream(RESULT, { instant: true });
    d.endTurn(); // close (pull_request + deploy = 2 tools — no collapse)
    await d.beat(1600);

    // 10) Offer to run this every day, posted to Slack / Teams.
    d.caption("Get this every morning — in Slack or Teams");
    await d.stream(
      "Want this every morning? I can audit your storefront daily and post the report to your team.",
      { cps: 44 },
    );
    d.showDigest();
    await d.beat(1800);
    d.showCursor();
    await d.beat(600);
    await d.click("connect-slack");
    d.connectDigest("slack");
    d.hideCursor();
    await d.beat(800);
    d.endTurn();
    d.caption("From a one-off audit to a daily, automated report");
    await d.beat(4200);
  },
};
