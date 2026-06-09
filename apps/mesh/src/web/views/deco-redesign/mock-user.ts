// The USER layer — the space above orgs (2026-06-08, Gui). You land in YOUR
// space (no /$org), like chatgpt.com: a personal agent that knows you and knows
// how to talk to your Agents, your own connections, and the list of Agents
// (capital A — orgs/teammates) you have. Entering an Agent drops you into the
// org experience (/$org). Mock only.

/** One thing an Agent did/proposed — shown in the home's "Agent updates". */
export interface AgentUpdate {
  id: string;
  title: string;
  change?: string; // a PR/change ref, e.g. "#3302"
  needsReview: boolean;
}

/** An Agent (capital A) the user has — a teammate they can enter. */
export interface UserAgent {
  id: string;
  name: string;
  kind: "storefront" | "company";
  blurb: string;
  needsReview: number;
  icon?: string; // logo URL (else a fallback glyph)
  updates: AgentUpdate[];
}

export const USER = {
  name: "Rafael",
  firstName: "Rafael",
  email: "rafael.valls@deco.cx",
};

export const USER_AGENTS: UserAgent[] = [
  {
    id: "farm-rio",
    name: "Farm Rio",
    kind: "storefront",
    blurb: "Storefront teammate — operates farmrio.com",
    needsReview: 2,
    icon: "https://www.google.com/s2/favicons?domain=farmrio.com&sz=64",
    updates: [
      {
        id: "fr-1",
        title: "Added Product schema to 412 PDPs",
        change: "#3302",
        needsReview: true,
      },
      {
        id: "fr-2",
        title: "Generated alt-text for 84 hero images",
        needsReview: true,
      },
    ],
  },
  {
    id: "deco-company",
    name: "Deco",
    kind: "company",
    blurb: "Your company agent — improves your storefronts overnight",
    needsReview: 1,
    icon: "https://www.google.com/s2/favicons?domain=deco.cx&sz=64",
    updates: [
      {
        id: "dc-1",
        title: "Shipped a fix for the dresses PLP 500s",
        change: "#3318",
        needsReview: true,
      },
      {
        id: "dc-2",
        title: "Tuned the SEO skill from this week's wins",
        needsReview: false,
      },
    ],
  },
  {
    id: "monte-carlo",
    name: "Monte Carlo",
    kind: "storefront",
    blurb: "Storefront teammate — operates montecarlo.com.br",
    needsReview: 0,
    icon: "https://www.google.com/s2/favicons?domain=montecarlo.com.br&sz=64",
    updates: [],
  },
];

/** Connections that belong to YOU (not to an Agent) — what your personal agent
 *  can draw on, and what it carries into the Agents you work with. */
export interface UserConnection {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  connected: boolean;
}

export const USER_CONNECTIONS: UserConnection[] = [
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Read and draft from your inbox.",
    icon: "https://www.google.com/s2/favicons?domain=mail.google.com&sz=64",
    connected: true,
  },
  {
    id: "gcal",
    name: "Google Calendar",
    blurb: "See your schedule and book time.",
    icon: "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=64",
    connected: true,
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Your repos, issues and PRs.",
    icon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
    connected: true,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Reach you where you work.",
    icon: "https://www.google.com/s2/favicons?domain=slack.com&sz=64",
    connected: false,
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    blurb: "Ping you and take requests on the go.",
    icon: "https://www.google.com/s2/favicons?domain=whatsapp.com&sz=64",
    connected: false,
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Your notes and docs.",
    icon: "https://www.google.com/s2/favicons?domain=notion.so&sz=64",
    connected: false,
  },
  {
    id: "linear",
    name: "Linear",
    blurb: "Turn requests into tracked work.",
    icon: "https://www.google.com/s2/favicons?domain=linear.app&sz=64",
    connected: false,
  },
];
