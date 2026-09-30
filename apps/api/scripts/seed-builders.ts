#!/usr/bin/env bun
/**
 * Seed the "Deco Builders" public org (`/builders`) with forum channels,
 * topics, replies and votes, for local development and demos.
 *
 *   DATABASE_URL=… bun run scripts/seed-builders.ts --owner you@example.com
 *
 * The owner must already have signed up; they join as `owner`. Every other
 * author is a synthetic member (`@example.com`). Refuses to run twice: delete
 * the org to re-seed.
 */

import { parseArgs } from "node:util";
import { sql } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { closeDatabase, getDb } from "../src/database";
import { TaskBoardStorage } from "../src/storage/task-board";
import { VirtualMCPStorage } from "../src/storage/virtual";

const ORG = { name: "Deco Builders", slug: "builders" };

const MEMBERS = [
  { key: "marina", name: "Marina Costa" },
  { key: "diego", name: "Diego Almeida" },
  { key: "priya", name: "Priya Nair" },
  { key: "lucas", name: "Lucas Ferreira" },
  { key: "ana", name: "Ana Beatriz Souza" },
  { key: "tomas", name: "Tomás Rivera" },
  { key: "kenji", name: "Kenji Watanabe" },
  { key: "julia", name: "Julia Mendes" },
  { key: "otavio", name: "Otávio Lima" },
  { key: "sofia", name: "Sofia Andrade" },
] as const;

type Author = (typeof MEMBERS)[number]["key"] | "owner";

const KINDS: Record<string, string> = {
  Announcement: "#6366f1",
  Proposal: "#0ea5e9",
  Question: "#f59e0b",
  Role: "#10b981",
  Bounty: "#ef4444",
  Gig: "#8b5cf6",
  Profile: "#14b8a6",
  Help: "#64748b",
  "Show & tell": "#ec4899",
};

interface Reply {
  by: Author;
  /** Hours after the topic was posted. */
  at: number;
  body: string;
  replies?: Omit<Reply, "replies">[];
}

interface Topic {
  by: Author;
  kind: string;
  daysAgo: number;
  status?: string;
  title: string;
  body: string;
  voters: Author[];
  replies: Reply[];
}

interface Channel {
  title: string;
  description: string;
  kinds: string[];
  topics: Topic[];
}

const CHANNELS: Channel[] = [
  {
    title: "Roadmap",
    description:
      "What we're building, what's next, and what shipped. Propose, vote, argue.",
    kinds: ["Announcement", "Proposal", "Question"],
    topics: [
      {
        by: "owner",
        kind: "Announcement",
        daysAgo: 1,
        title: "Welcome to Deco Builders: we're moving off Discord",
        body: `Chat rooms reward whoever has infinite time. This is a forum instead: the important topics surface, you read a thoughtful discussion, you add your point.

**How it works**
- Every topic here is also a task. When a discussion ends in something to do, it moves on the board and an agent or a person picks it up.
- Vote on what matters. Hot ranks by votes and recent replies.
- **Roadmap** is where the product is decided in public. **Jobs & Bounties** and **Open to Work** are where builders find each other.

Discord goes read-only in a month. Tell us what's missing.`,
        voters: [
          "marina",
          "diego",
          "priya",
          "lucas",
          "ana",
          "kenji",
          "julia",
          "sofia",
        ],
        replies: [
          {
            by: "marina",
            at: 2,
            body: "Finally. I lost a whole migration thread in #general last month because 200 memes landed on top of it.",
          },
          {
            by: "kenji",
            at: 5,
            body: "Will there be email digests? I check forums weekly, not hourly.",
            replies: [
              {
                by: "owner",
                at: 6,
                body: "Yes. Follow a topic or a channel and you get it in your inbox and in the daily digest.",
              },
            ],
          },
          {
            by: "tomas",
            at: 20,
            body: "Suggestion: pin a 'start here' topic in each channel with the template for posting.",
          },
        ],
      },
      {
        by: "priya",
        kind: "Proposal",
        daysAgo: 6,
        status: "todo",
        title: "Deco Score should run daily, not once",
        body: `Right now the Deco Score is a one-off report. The numbers that matter (LCP, CLS, broken links, SEO basics) drift every deploy.

**Proposal**
- Re-run the score daily for every property.
- Post the delta to the brief: "LCP +300ms since yesterday, caused by the new hero banner".
- Each regression opens a card with a draft fix.

A report that makes you anxious once is worse than a number that keeps you honest every day.`,
        voters: ["diego", "lucas", "ana", "kenji", "otavio", "sofia", "owner"],
        replies: [
          {
            by: "diego",
            at: 3,
            body: "+1. The score being inside the product instead of a PDF is the whole point.",
          },
          {
            by: "lucas",
            at: 9,
            body: "Careful with noise. CrUX data is a 28-day window, so a daily run would show the same field numbers. Lab runs are noisy. Maybe daily lab + weekly field?",
            replies: [
              {
                by: "priya",
                at: 11,
                body: "Good point. Lab for the regression alert, field for the trend line.",
              },
            ],
          },
          {
            by: "owner",
            at: 30,
            body: "Moving this to Planned. We'll ship the daily lab run first, gated on the property having a repo so the fix card can carry a PR.",
          },
        ],
      },
      {
        by: "ana",
        kind: "Proposal",
        daysAgo: 4,
        title:
          "Project-first files: stop mixing chat uploads with the org library",
        body: `When I open Files I see uploads from every chat, reports, skills and the site's assets in one list. It's impossible to find the context doc I wrote last week.

Proposal: files belong to a project first. Chat uploads live under that chat's session folder. The org library shows project folders at the top level.`,
        voters: ["marina", "julia", "tomas", "sofia"],
        replies: [
          {
            by: "julia",
            at: 4,
            body: "Same pain. Also, filters in the Media view don't persist between visits.",
          },
          {
            by: "otavio",
            at: 26,
            body: "Would a toggle between the rendered view and raw files help? Most people want the nice view, power users want the tree.",
          },
        ],
      },
      {
        by: "diego",
        kind: "Question",
        daysAgo: 3,
        title: "Can I run task cards locally with my own Claude subscription?",
        body: "I have Claude Max and a beefy laptop. Is there a way to pick up a card from the board, run it locally, and have the PR and evidence show up on the card like a cloud run?",
        voters: ["kenji", "lucas"],
        replies: [
          {
            by: "kenji",
            at: 1,
            body: "deco Link does part of this: it carries your local subscription. Not sure it reports back to the card yet.",
          },
          {
            by: "owner",
            at: 7,
            body: "That's the plan: a task is location-agnostic. 'Run' defaults to cloud, 'Open locally' hands it to Link and it reports back to the same card. Not shipped yet.",
          },
        ],
      },
      {
        by: "tomas",
        kind: "Proposal",
        daysAgo: 9,
        status: "in_progress",
        title: "Jira → sandbox → PR, without a human copying the ticket",
        body: "Our client lives in Jira. Today someone reads the ticket, pastes it into a chat and babysits the run. Proposal: a Jira column triggers a run, the PR link and preview go back to the ticket, and the reviewer agent does the first QA pass.",
        voters: ["marina", "priya", "ana", "otavio", "owner"],
        replies: [
          {
            by: "marina",
            at: 12,
            body: "We demoed a version of this internally. The manual validation step is where the hours go.",
          },
          {
            by: "sofia",
            at: 40,
            body: "Please make the acceptance criteria a table the reviewer fills in. Free-text QA notes are useless for the client.",
          },
        ],
      },
      {
        by: "lucas",
        kind: "Question",
        daysAgo: 12,
        status: "done",
        title: "Are migrations from Fresh to TanStack Start forced?",
        body: "We have 3 sites on the Deno/Fresh stack. Do we have to migrate, and by when?",
        voters: ["diego", "julia", "otavio"],
        replies: [
          {
            by: "owner",
            at: 5,
            body: "Not forced. Pricing doesn't change with the stack, and the migration tooling is open. We do recommend moving before Deno's EOL; the parity tool compares prod and candidate section by section so you can move at your pace.",
          },
          { by: "lucas", at: 8, body: "Clear, thanks. Closing this." },
        ],
      },
    ],
  },
  {
    title: "Jobs & Bounties",
    description:
      "Roles, paid bounties and freelance gigs implementing AI in enterprise digital experiences.",
    kinds: ["Role", "Bounty", "Gig"],
    topics: [
      {
        by: "owner",
        kind: "Bounty",
        daysAgo: 2,
        title: "Bounty: a skill that ports a Fresh section to TanStack Start",
        body: `**Scope**
A Claude Code skill that takes one Fresh/Preact section from a deco site and ports it to a TanStack Start + React section with the same props schema.

**Acceptance criteria**
- Works on 5 sample sections (carousel, shelf, header, footer, rich text).
- Visual parity within the parity tool's default threshold.
- Props schema unchanged, so the CMS content keeps working.

**Reward:** USD 1,500 · **Deadline:** 3 weeks after claim`,
        voters: ["diego", "kenji", "lucas", "otavio", "priya"],
        replies: [
          {
            by: "kenji",
            at: 3,
            body: "Does it need to handle islands with client state, or only server-rendered sections?",
            replies: [
              {
                by: "owner",
                at: 4,
                body: "Both. The carousel is the island case on purpose.",
              },
            ],
          },
          {
            by: "diego",
            at: 22,
            body: "I'd like to claim this. I've ported ~40 sections by hand for a client already.",
          },
        ],
      },
      {
        by: "marina",
        kind: "Role",
        daysAgo: 5,
        title:
          "Forward Deployed Engineer: AI for enterprise storefronts (remote, BR)",
        body: `We're a digital agency working with large fashion and home-goods retailers. You'll run agents on real storefronts: performance, PLP experiments, content ops.

- **Stack:** TypeScript, React, VTEX or Shopify, Claude Code
- **Remote**, Brazil time zones
- **Comp:** CLT or PJ, competitive, depends on seniority

You'll own 5–10 accounts with agents doing the repetitive work. Reply here or use Contact.`,
        voters: ["ana", "sofia", "julia"],
        replies: [
          {
            by: "sofia",
            at: 6,
            body: "Is English required? Most of the retailers I've worked with operate in Portuguese.",
            replies: [
              {
                by: "marina",
                at: 8,
                body: "Reading English is enough. Client work is in Portuguese.",
              },
            ],
          },
        ],
      },
      {
        by: "otavio",
        kind: "Gig",
        daysAgo: 7,
        title: "2-week Core Web Vitals sprint for a home-goods storefront",
        body: "LCP is 4.1s on mobile PDPs. Looking for someone to get it under 2.5s. Budget BRL 12k, fixed. Repo access and staging provided; Deco Score before/after is the acceptance test.",
        voters: ["lucas", "kenji"],
        replies: [
          {
            by: "lucas",
            at: 10,
            body: "Happy to take a look. Is the hero image served from the platform's CDN or yours?",
          },
        ],
      },
      {
        by: "julia",
        kind: "Bounty",
        daysAgo: 10,
        status: "in_progress",
        title: "Bounty: MCP app that shows today's sales projection",
        body: `A small MCP app: captured revenue so far, projection to 23:59, and comparison with the same weekday last week, from VTEX orders (paid + pending, cancelled excluded).

**Reward:** USD 800 · Claimed by @Tomás Rivera`,
        voters: ["marina", "priya", "tomas", "owner"],
        replies: [
          {
            by: "tomas",
            at: 2,
            body: "Claimed. First version by Friday, with a WhatsApp digest at 9h/12h/18h as a stretch goal.",
          },
          {
            by: "priya",
            at: 50,
            body: "Make the data definition visible on screen. Every client asks why the number differs from their BI.",
          },
        ],
      },
    ],
  },
  {
    title: "Open to Work",
    description:
      "Freelancers and builders available for work. One profile per person, kept current.",
    kinds: ["Profile"],
    topics: [
      {
        by: "kenji",
        kind: "Profile",
        daysAgo: 3,
        title: "Kenji Watanabe · Performance engineer · available November",
        body: `**Headline:** I make storefronts fast.
- **Skills:** Core Web Vitals, edge caching, TanStack Start, Cloudflare Workers
- **Rate:** USD 70/h or fixed-price sprints
- **Availability:** 20h/week from November
- **Recent:** took a fashion PDP from 3.8s to 1.9s LCP in 10 days`,
        voters: ["otavio", "marina"],
        replies: [
          {
            by: "otavio",
            at: 5,
            body: "Sent you a message about the home-goods sprint.",
          },
        ],
      },
      {
        by: "sofia",
        kind: "Profile",
        daysAgo: 6,
        title:
          "Sofia Andrade · Content ops + CMS migrations · open to full-time",
        body: `- **Skills:** headless CMS migrations, content modeling, blog automation with agents, QA
- **Languages:** Portuguese, Spanish, English
- **Availability:** full-time, remote
- **Looking for:** a team shipping AI into retail content workflows`,
        voters: ["marina", "julia", "ana"],
        replies: [],
      },
      {
        by: "diego",
        kind: "Profile",
        daysAgo: 11,
        title:
          "Diego Almeida · Frontend + migrations · booked until mid-October",
        body: `- **Skills:** Fresh → TanStack Start migrations, VTEX IO, section libraries, parity testing
- **Rate:** BRL 180/h
- **Availability:** busy until Oct 15, then 30h/week`,
        voters: ["lucas"],
        replies: [],
      },
    ],
  },
  {
    title: "Help",
    description: "Stuck? Ask here. Answers that help others get voted up.",
    kinds: ["Help", "Show & tell"],
    topics: [
      {
        by: "julia",
        kind: "Help",
        daysAgo: 1,
        title: "Preview URL on the card is empty after the PR opened",
        body: "The run opened a PR, the checks passed, but the card shows no preview link. The site deploys on every PR. What am I missing?",
        voters: ["ana"],
        replies: [
          {
            by: "lucas",
            at: 2,
            body: "The card reads the preview from a deploy status on the head commit. If your deploy posts a check run instead of a commit status, it won't be picked up.",
          },
        ],
      },
      {
        by: "ana",
        kind: "Show & tell",
        daysAgo: 8,
        title:
          "Our reviewer agent caught a checkout regression before it shipped",
        body: "Sharing because it felt like magic: the QA reviewer took screenshots of the cart on mobile, noticed the coupon field overlapped the total, and requested changes. The fix was one line. The screenshot is in the card.",
        voters: ["marina", "priya", "tomas", "kenji", "owner"],
        replies: [
          {
            by: "priya",
            at: 3,
            body: "Which viewport sizes does it test by default?",
          },
          {
            by: "ana",
            at: 4,
            body: "375 and 1440 in our setup. You can set them in the board prompt.",
          },
        ],
      },
      {
        by: "otavio",
        kind: "Help",
        daysAgo: 0,
        title: "How do I connect Search Console with a service account?",
        body: "Our client won't grant OAuth to a personal account. Is there a way to connect Search Console using a service account key?",
        voters: [],
        replies: [],
      },
    ],
  },
];

const HOUR = 3600_000;

async function main() {
  const { values } = parseArgs({
    options: { owner: { type: "string" } },
  });
  const database = getDb();
  const db = database.db;

  try {
    const existing = await db
      .selectFrom("organization")
      .select("id")
      .where("slug", "=", ORG.slug)
      .executeTakeFirst();
    if (existing) {
      console.log(
        `/${ORG.slug} already exists (${existing.id}); nothing to do.`,
      );
      return;
    }

    const owner = values.owner
      ? await db
          .selectFrom("user")
          .select("id")
          .where("email", "=", values.owner)
          .executeTakeFirst()
      : await db
          .selectFrom("user")
          .select("id")
          .orderBy("createdAt", "asc")
          .executeTakeFirst();
    if (!owner) {
      throw new Error(
        values.owner
          ? `No user with email ${values.owner}; sign up first.`
          : "No users yet; sign up first or pass --owner.",
      );
    }

    const now = Date.now();
    const organizationId = crypto.randomUUID();
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: ORG.name,
        slug: ORG.slug,
        logo: null,
        metadata: null,
        createdAt: new Date(now - 30 * 24 * HOUR).toISOString(),
      })
      .execute();
    await db
      .insertInto("organization_billing")
      .values({ organization_id: organizationId })
      .execute();

    const userIds: Record<Author, string> = { owner: owner.id } as Record<
      Author,
      string
    >;
    for (const m of MEMBERS) {
      const email = `${m.key}@example.com`;
      const found = await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst();
      const id = found?.id ?? crypto.randomUUID();
      if (!found) {
        await sql`insert into "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
          values (${id}, ${email}, true, ${m.name}, now(), now())`.execute(db);
      }
      userIds[m.key] = id;
    }
    for (const [key, userId] of Object.entries(userIds)) {
      await db
        .insertInto("member")
        .values({
          id: crypto.randomUUID(),
          organizationId,
          userId,
          role: key === "owner" ? "owner" : "user",
          createdAt: new Date(now - 29 * 24 * HOUR).toISOString(),
        })
        .execute();
    }

    const tagIds: Record<string, string> = {};
    for (const [name, color] of Object.entries(KINDS)) {
      const id = generatePrefixedId("tag");
      await db
        .insertInto("organization_tags")
        .values({
          id,
          organization_id: organizationId,
          name,
          color,
          created_at: new Date().toISOString(),
        })
        .execute();
      tagIds[name] = id;
    }

    const projects = new VirtualMCPStorage(db);
    const board = new TaskBoardStorage(db);
    let topicCount = 0;
    let replyCount = 0;

    for (const channel of CHANNELS) {
      const project = await projects.create(organizationId, owner.id, {
        title: channel.title,
        description: channel.description,
        status: "active",
        pinned: true,
        connections: [],
        metadata: { forum: { visibility: "public", kinds: channel.kinds } },
      });

      // Oldest first, so key numbers read in posting order.
      for (const topic of [...channel.topics].sort(
        (a, b) => b.daysAgo - a.daysAgo,
      )) {
        const postedAt = now - topic.daysAgo * 24 * HOUR - 3 * HOUR;
        const item = await board.create({
          organizationId,
          title: topic.title,
          description: topic.body,
          status: topic.status ?? "triage",
          projectId: project.id,
          by: userIds[topic.by],
        });
        await board.setItemTags(
          item.id,
          [tagIds[topic.kind]!],
          userIds[topic.by],
        );

        let lastAt = postedAt;
        const postReply = async (reply: Reply, parentId: string | null) => {
          const comment = await board.createComment({
            taskBoardItemId: item.id,
            organizationId,
            parentId,
            authorId: userIds[reply.by],
            body: reply.body,
          });
          if (!comment) throw new Error(`Reply failed on ${topic.title}`);
          const at = Math.min(postedAt + reply.at * HOUR, now - 60_000);
          lastAt = Math.max(lastAt, at);
          await sql`update task_board_comments set created_at = ${new Date(at).toISOString()}, updated_at = ${new Date(at).toISOString()} where id = ${comment.id}`.execute(
            db,
          );
          replyCount++;
          return comment.id;
        };
        for (const reply of topic.replies) {
          const rootId = await postReply(reply, null);
          for (const child of reply.replies ?? []) {
            await postReply(child, rootId);
          }
        }

        for (const voter of topic.voters) {
          await db
            .insertInto("task_board_item_votes")
            .values({ task_board_item_id: item.id, user_id: userIds[voter] })
            .execute();
        }
        await sql`update task_board_items set created_at = ${new Date(postedAt).toISOString()}, updated_at = ${new Date(lastAt).toISOString()} where id = ${item.id}`.execute(
          db,
        );
        topicCount++;
      }
    }

    console.log(
      `Seeded /${ORG.slug}: ${CHANNELS.length} channels, ${topicCount} topics, ${replyCount} replies, ${MEMBERS.length + 1} members.`,
    );
  } finally {
    await closeDatabase(database);
  }
}

await main();
